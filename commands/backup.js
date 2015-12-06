var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var del = require('del');
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
		.forEach(mindstate.plugins, function(next, plugin) {
			plugin.backup(function(err) {
				if (err == 'SKIP') return next(); // Ignore skipped plugins
				return next(err);
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
				.destination(_.trimRight(mindstate.config.server.address, '/') + '/' + mindstate.config.server.filename)
				.output(function(data) {
					console.log(colors.blue('[RSYNC]'), data.toString());
				}, function(err) {
					console.log(colors.blue('[RSYNC]'), colors.red('Error:', data.toString()));
				});

			if (mindstate.program.verbose) console.log(colors.grey('Begin RSYNC', rsyncInst.command()));

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