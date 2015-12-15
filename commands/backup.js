var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var del = require('del');
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
				if (mindstate.program.verbose) console.log(colors.grey('Using temp directory:', dir));
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

		// Create tarball {{{
		.then(function(next) {
			this.tarPath = temp.path({suffix: '.tar'});
			if (mindstate.program.verbose) console.log(colors.grey('Creating Tarball', this.tarPath));
			new tarGz().compress(mindstate.tempDir, this.tarPath, next);
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
						console.log(colors.grey('Delta file would be same name as current timestamp, skipping delta copy stage'));
						console.log(colors.grey('This should only occur if you are attempting extremely frequent backups without a second / microsecond marker in the output filename'));
						return next('SKIP');
					}
					next(null, latest);
				})
				.then(function(next) {
					var cmd = 'cp "' + mindstate.config.server.dir + '/' + this.latest.name + '" "' + mindstate.config.server.dir + '/' + this.destFile + '"';
					if (mindstate.program.verbose) console.log(colors.grey('[SSH/cp]', 'run', cmd));

					this.client.conn.exec(cmd, function(err, stream) {
						if (err) return next(err);
						stream
							.on('close', function(code) {
								if (mindstate.program.verbose) console.log(colors.grey('[SSH/cp]', 'Exit with code', code));
								next(code == 0 ? undefined : 'SSH/cp exit code ' + code);
							})
							.on('data', function(data) {
								if (mindstate.program.verbose) console.log(colors.grey('[SSH/cp]', data.toString()));
							})
							.stderr.on('data', function(data) {
								if (mindstate.program.verbose) console.log(colors.grey('[SSH/cp]', data.toString()));
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
				console.log(colors.grey('Upload stage skipped'));
				return next();
			}

			var rsyncInst = new rsync()
				.archive()
				.compress()
				.source(this.tarPath)
				.destination(this.destPrefix + this.destFile)
				.output(function(data) {
					console.log(colors.blue('[RSYNC]'), data.toString());
				}, function(err) {
					console.log(colors.blue('[RSYNC]'), colors.red('Error:', data.toString()));
				});

			if (mindstate.program.verbose) {
				rsyncInst.progress(); // Enable progress reporting
				console.log(colors.grey('Begin RSYNC', rsyncInst.command()));
			}

			rsyncInst.execute(next);
		})
		// }}}

		// Cleanup + end {{{
		.end(function(err) {
			// Cleaner {{{
			if (mindstate.tempDir) {
				if (!mindstate.program.clean) {
					console.log(colors.grey('Cleaner: Skipping temp directory cleanup for', mindstate.tempDir));
				} else {
					if (mindstate.program.verbose) console.log(colors.grey('Cleaner: Cleaning up temp directory', mindstate.tempDir));
					del.sync(mindstate.tempDir, {force: true});
				}
			}

			if (this.tarPath) {
				if (!mindstate.program.clean) {
					console.log(colors.grey('Cleaner: Skipping tarball cleanup for', this.tarPath));
				} else {
					if (mindstate.program.verbose) console.log(colors.grey('Cleaner: Cleaning up tarball', this.tarPath));
					del.sync(this.tarPath, {force: true});
				}
			}
			// }}}

			if (!err) console.log(colors.green.bold('MindState backup completed!'));
			finish(err);
		});
		// }}}
};
