var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var del = require('del');
var fileEmitter = require('file-emitter');
var filesize = require('filesize');
var fs = require('fs');
var tarGz = require('tar.gz');
var temp = require('temp');
var rsync = require('rsync');

module.exports = function(finish) {
	async()
		// Setup tempDir {{{
		.then(function(next) {
			temp.mkdir({prefix: 'mindstate-'}, function(err, dir) {
				if (err) return next(err);
				if (mindstate.program.verbose > 2) console.log('Using temp directory:', dir);
				mindstate.tempDir = dir;
				next();
			});
		})
		// }}}

		.then(mindstate.functions.loadConfig)

		// Execute each plugin {{{
		.forEach(mindstate.plugins, function(nextPlugin, plugin) {
			async()
				.then(function(next) {
					// Plugin sanity checks {{{
					if (!_.isFunction(plugin.backup)) {
						if (mindstate.program.verbose) console.log('Plugin', plugin.name, 'does not support backup');
						return next('SKIP');
					}
					next();
					// }}}
				})
				.then('workspace', function(next) {
					// Setup workspace {{{
					var workspaceDir = mindstate.tempDir + '/' + plugin.name;
					fs.mkdir(workspaceDir, function(err) {
						if (err) return next(err);
						next(null, {
							name: plugin.name,
							dir: workspaceDir,
						});
					});
					// }}}
				})
				.then(function(next) {
					// Execute Plugin {{{
					plugin.backup(function(err) {
						if (err == 'SKIP') return next(); // Ignore skipped plugins
						return next(err);
					}, this.workspace);
					// }}}
				})
				.end(function(err) {
					if (err && err == 'SKIP') return nextPlugin();
					nextPlugin(err);
				});
		})
		// }}}

		// Show dir stats {{{
		.then(function(next) {
			if (!mindstate.program.verbose) return next();

			var fileCount = 0;
			var totalSize = 0;

			fileEmitter(mindstate.tempDir)
				.on('file', function(file) {
					fileCount++;
					totalSize += file.stats.size;
				})
				.on('end', function() {
					console.log(colors.blue('[Stats]'), 'File count of backup =', colors.cyan(fileCount));
					console.log(colors.blue('[Stats]'), 'Total size of backup =', colors.cyan(filesize(totalSize)));
					next();
				});
		})
		// }}}

		// Create tarball {{{
		.then(function(next) {
			mindstate.tarPath = temp.path({suffix: '.tar'});
			if (mindstate.program.verbose > 2) console.log('Creating Tarball', mindstate.tarPath);
			new tarGz().compress(mindstate.tempDir, mindstate.tarPath, next);
		})
		// }}}

		// Show tarball stats {{{
		.then(function(next) {
			if (!mindstate.program.verbose) return next();
			fs.stat(mindstate.tarPath, function(err, stats) {
				if (err) return next(err);
				console.log(colors.blue('[Stats]'), 'Size of comrpessed tarball =', colors.cyan(filesize(stats.size)));
				next();
			});
		})
		// }}}

		// Prepare all file paths {{{
		.then(function(next) {
			this.destPrefix = _.trimRight(mindstate.config.server.address, '/') + '/';
			this.destFile = mindstate.config.server.filename;
			next();
		})
		// }}}

		// Delta prepare {{{
		// Attempt to get the latest backup and copy it to the new file name
		// Using this method Rsync can do a differencial on the last backup and hopefully not have to transfer as much on each nightly
		.then(function(next) {
			if (!mindstate.program.upload) return next();

			async()
				.set('destFile', this.destFile)
				.then('client', mindstate.functions.connect)
				.then('list', function(next) {
					mindstate.functions.list(next, this.client, {
						sort: 'date',
						server: true,
					});
				})
				.then('latest', function(next) { // Clip the last file
					var latest = _.last(this.list);
					if (!this.list.length) return next('SKIP');
					if (latest.name == this.destFile) {
						console.log(colors.blue('[Delta]'), 'Delta file would be same name as current timestamp, skipping delta copy stage');
						console.log(colors.blue('[Delta]'), 'This should only occur if you are attempting extremely frequent backups without a second / microsecond marker in the output filename');
						return next('SKIP');
					}
					next(null, latest);
				})
				.then(function(next) {
					var cmd = 'cp "' + mindstate.config.server.dir + '/' + this.latest.name + '" "' + mindstate.config.server.dir + '/' + this.destFile + '"';
					if (mindstate.program.verbose) console.log(colors.blue('[Delta/SSH/cp]'), 'Run', cmd);

					this.client.conn.exec(cmd, function(err, stream) {
						if (err) return next(err);
						stream
							.on('close', function(code) {
								if (mindstate.program.verbose) console.log(colors.blue('[Delta/SSH/cp]'), 'Exit with code', colors.cyan(code));
								next(code == 0 ? undefined : 'SSH/cp exit code ' + code);
							})
							.on('data', function(data) {
								if (mindstate.program.verbose) console.log(colors.blue('[Delta/SSH/cp]'), data.toString());
							})
							.stderr.on('data', function(data) {
								if (mindstate.program.verbose) console.log(colors.blue('[Delta/SSH/cp]'), data.toString());
							});
					});
				})
				.end(function(err) {
					if (err == 'SKIP') {
						return next();
					} else {
						return next(err);
					}
				});
		})
		// }}}

		// Rsync {{{
		.then(function(next) {
			if (!mindstate.program.upload) {
				console.log(colors.blue('[RSYNC]'), 'Upload stage skipped');
				return next();
			}

			var rsyncInst = new rsync()
				.set('stats')
				.archive()
				.compress()
				.source(mindstate.tarPath)
				.destination(this.destPrefix + this.destFile)
				.output(function(data) {
					console.log(colors.blue('[RSYNC]'), '1>', data.toString());
				}, function(err) {
					console.log(colors.blue('[RSYNC]'), '2>', colors.red('ERROR', data.toString()));
				});

			if (mindstate.program.verbose) {
				rsyncInst.progress(); // Enable progress reporting
				console.log(colors.blue('[RSYNC]'), 'Run', rsyncInst.command());
			}

			rsyncInst.execute(next);
		})
		// }}}

		// Cleanup + end {{{
		.end(function(err) {
			// Cleanup {{{
			if (mindstate.tempDir) {
				if (!mindstate.program.clean) {
					console.log(colors.blue('[Cleanup]'), 'Skipping temp directory cleanup for', colors.cyan(mindstate.tempDir));
				} else {
					if (mindstate.program.verbose) console.log(colors.blue('[Cleanup]'), 'Delete temp directory', colors.cyan(mindstate.tempDir));
					del.sync(mindstate.tempDir, {force: true});
				}
			}

			if (mindstate.tarPath) {
				if (!mindstate.program.clean) {
					console.log(colors.blue('[Cleanup]'), 'Skipping tarball cleanup for', colors.cyan(mindstate.tarPath));
				} else {
					if (mindstate.program.verbose) console.log(colors.blue('[Cleanup]'), 'Cleaning up tarball', colors.cyan(mindstate.tarPath));
					del.sync(mindstate.tarPath, {force: true});
				}
			}
			// }}}

			if (!err) console.log(colors.green.bold('MindState backup completed!'));
			finish(err);
		});
		// }}}
};
