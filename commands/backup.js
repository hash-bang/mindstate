var _ = require('lodash');
var async = require('async-chainable');
var childProcess = require('child_process');
var colors = require('colors');
var fileEmitter = require('file-emitter');
var filesize = require('filesize');
var fs = require('fs');
var tar = require('tar-fs');
var temp = require('temp');
var rimraf = require('rimraf');
var rsync = require('rsync');
var which = require('which');

module.exports = function(finish, settings) {
	async()
		// Defaults {{{
		.then(function(next) {
			_.defaults(settings, {
				clean: true,
				upload: true,
			});
			next();
		})
		// }}}

		// Check for binaries {{{
		.forEach(['gzip', 'rsync'], function(next, bin) {
			which('mysqldump', function(err) {
				if (err) if (mindstate.verbose) return next('Required binary `' + bin + '` is not in PATH');
				next();
			});
		})
		// }}}

		// Setup tempDir {{{
		.then(function(next) {
			temp.mkdir({prefix: 'mindstate-'}, function(err, dir) {
				if (err) return next(err);
				if (mindstate.verbose > 2) console.log(colors.blue('[Backup]'), 'Using temp directory', colors.cyan(dir));
				mindstate.tempDir = dir;
				next();
			});
		})
		// }}}

		// Load config {{{
		.then(mindstate.functions.loadConfig)
		// }}}

		// Execute each plugin {{{
		.forEach(mindstate.plugins, function(nextPlugin, plugin) {
			if (mindstate.verbose > 3) console.log(colors.blue('[Backup]'), 'Invoke Plugin', colors.cyan(plugin.name));
			async()
				.then(function(next) {
					// Plugin sanity checks {{{
					if (!_.isFunction(plugin.backup)) {
						if (mindstate.verbose > 1) console.log(colors.blue('[Backup]'), 'Plugin', plugin.name, 'does not support backup');
						return next('SKIP');
					}
					next();
					// }}}
				})
				.then('workspace', function(next) {
					// Setup workspace {{{
					var workspaceDir = mindstate.tempDir + '/' + plugin.name;
					if (mindstate.verbose > 2) console.log(colors.blue('[Backup/' + plugin.name + ']'), 'Mkdir', colors.cyan(workspaceDir));
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
			if (!mindstate.verbose) return next();

			var fileCount = 0;
			var totalSize = 0;

			fileEmitter(mindstate.tempDir)
				.on('file', function(file) {
					fileCount++;
					totalSize += file.stats.size;
				})
				.on('end', function() {
					console.log(colors.blue('[Mindstate]'), 'File count of backup =', colors.cyan(fileCount));
					console.log(colors.blue('[Mindstate]'), 'Total size of backup =', colors.cyan(filesize(totalSize)));
					next();
				});
		})
		// }}}

		// Create tarball {{{
		.then(function(next) {
			mindstate.tarPath = temp.path({suffix: '.tar'});
			if (mindstate.verbose > 2) console.log(colors.blue('[Tar]'), 'Creating Tarball', colors.cyan(mindstate.tarPath));

			/**
			* Setup a pipeline for the following:
			*
			* 1. Stream: Tar bundler
			* 2. Process: gzip --resyncable --stdout
			* 3. File Stream: mindstate.tarPath
			*
			* Annoyingly we can't just use something like the NPM modules `tar.gz` / `targz` etc. as they all implement zlip which does not yet support `--resyncable` which protects the compression cypher from being scrambled - allowing RSYNC to perform delta compression even though there is a 1% overhead
			* - MC 2015-12-19
			*/


			var tarFile = fs.createWriteStream(mindstate.tarPath);
			var gzip = childProcess.spawn('gzip', ['--rsyncable', '--stdout']);
			gzip.stdout.pipe(tarFile);
			tarFile.on('close', function(err) {
				next();
			});
			gzip.on('close', function(code) {
				if (code == 0) return;
				console.log(colors.blue('[Tar]'), colors.red('Gzip exited with code', code));
			});

			tar
				.pack(mindstate.tempDir, {
					map: function(file) {
						if (mindstate.verbose > 1) console.log(colors.blue('[Tar]'), '+', file.name);
						return file;
					},
				})
				.pipe(gzip.stdin);
		})
		// }}}

		// Show tarball stats {{{
		.then(function(next) {
			if (!mindstate.verbose) return next();
			var self = this;
			fs.stat(mindstate.tarPath, function(err, stats) {
				if (err) return next(err);
				self.tarBallSize = stats.size;
				console.log(colors.blue('[Mindstate]'), 'Size of compressed tarball =', colors.cyan(filesize(stats.size)));
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
			if (!settings.upload) return next();

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
				.parallel({ // Calculate the delta source and dest paths
					deltaSrc: function(next) {
						mindstate.functions.realpath(next, this.client, mindstate.config.server.dir + '/' + this.latest.name);
					},
					deltaDst: function(next) {
						mindstate.functions.realpath(next, this.client, mindstate.config.server.dir + '/' + this.destFile);
					},
				})
				.then(function(next) {
					var cmd = 'cp "' + this.deltaSrc + '" "' + this.deltaDst + '"';
					if (mindstate.verbose) console.log(colors.blue('[Delta/SSH/cp]'), 'Run', cmd);

					this.client.conn.exec(cmd, function(err, stream) {
						if (err) return next(err);
						stream
							.on('close', function(code) {
								if (mindstate.verbose) console.log(colors.blue('[Delta/SSH/cp]'), 'Exit with code', colors.cyan(code));
								next(code == 0 ? undefined : 'SSH/cp exit code ' + code);
							})
							.on('data', function(data) {
								if (mindstate.verbose) console.log(colors.blue('[Delta/SSH/cp]'), data.toString());
							})
							.stderr.on('data', function(data) {
								if (mindstate.verbose) console.log(colors.blue('[Delta/SSH/cp]'), data.toString());
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
			if (!settings.upload) {
				console.log(colors.blue('[RSYNC]'), 'Upload stage skipped');
				return next();
			}

			var self = this;

			var rsyncInst = new rsync()
				.set('stats')
				.archive()
				.compress()
				.source(mindstate.tarPath)
				.destination(this.destPrefix + this.destFile)
				.output(function(data) {
					if (!mindstate.verbose) return;

					var dataStr = data.toString();
					if (mindstate.verbose > 2) console.log(colors.blue('[RSYNC]'), '1>', dataStr);
					var bytesSent = /^total bytes sent: (.*?)$/im.exec(dataStr);
					if (bytesSent) { // Looks like the Bytes-sent block
						var bytesSentInt = parseInt(bytesSent[1].replace(',', ''));
						console.log(colors.blue('[Mindstate]'), 'Bytes sent =', colors.cyan(filesize(bytesSentInt)));
						if (self.tarBallSize) console.log(colors.blue('[Mindstate]'), 'Bytes transmitted =', colors.cyan(Math.ceil((bytesSentInt / self.tarBallSize) * 100)), '%');
					}
				}, function(err) {
					if (mindstate.verbose > 2) console.log(colors.blue('[RSYNC]'), '2>', colors.red('ERROR', data.toString()));
				});

			if (mindstate.verbose > 1) {
				rsyncInst.progress(); // Enable progress reporting
				console.log(colors.blue('[RSYNC]'), 'Run', rsyncInst.command());
			}

			rsyncInst.execute(next);
		})
		// }}}

		// Cleanup + end {{{
		.end(function(err) {
			// Cleanup {{{
			async()
				.parallel([
					// Clean up temp directory {{{
					function(next) {
						if (!mindstate.tempDir) return next();

						if (!settings.clean) {
							console.log(colors.blue('[Cleanup]'), 'Skipping temp directory cleanup for', colors.cyan(mindstate.tempDir));
							return next();
						} else {
							if (mindstate.verbose) console.log(colors.blue('[Cleanup]'), 'Delete temp directory', colors.cyan(mindstate.tempDir));
							rimraf(mindstate.tempDir, {glob: false}, next);
						}
					},
					// }}}
					// Clean up tarball {{{
					function(next) {
						if (!mindstate.tarPath) return next();

						if (!settings.clean) {
							console.log(colors.blue('[Cleanup]'), 'Skipping tarball cleanup for', colors.cyan(mindstate.tarPath));
							return next();
						} else {
							if (mindstate.verbose) console.log(colors.blue('[Cleanup]'), 'Cleaning up tarball', colors.cyan(mindstate.tarPath));
							rimraf(mindstate.tarPath, {glob: false}, next);
						}
					},
					// }}}
				])
				.end(function() {
					if (!err) console.log(colors.green.bold('MindState backup completed!'));
					finish(err);
				});
			// }}}
		});
		// }}}
};
