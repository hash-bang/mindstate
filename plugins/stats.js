var _ = require('lodash');
var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var colors = require('colors');
var fs = require('fs');
var which = require('which');

module.exports = {
	name: 'stats',
	description: 'System statistics and diagnostics',
	backup: function(finish, workspace) {
		async()
			.use(asyncExec)
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.stats.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('Stats backup is disabled'));
					return next('SKIP');
				}
				if (!_.keys(mindstate.config.stats.commands).length) {
					if (mindstate.program.verbose) console.log(colors.grey('Stats backup has no commands to run'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.forEach(mindstate.config.stats.commands, function(nextCommand, command, id) {
				var bin = command.split(/\s+/)[0];
				var outStream;
				async()
					.use(asyncExec)
					.then('binPath', function(next) {
						which(bin, function(err, path) {
							if (err) {
								if (mindstate.program.verbose) console.log(colors.grey('Stats binary command `' + bin + '` is not in PATH'));
								return next('NOBIN');
							}
							next(null, path);
						});
					})
					.then(function(next) {
						if (mindstate.program.verbose) console.log(colors.blue('[Stats]'), 'Run', command);
						outStream = fs.createWriteStream(workspace.dir + '/' + id + '.txt');
						next();
					})
					.execDefaults({
						out: function(data) {
							outStream.write(data);
						},
					})
					.exec(command)
					.then(function(next) {
						outStream.end(next);
					})
					.end(function(err) {
						if (err == 'NOBIN') {
							// Disguard binary not found messages
							return nextCommand();
						} else {
							return nextCommand(err);
						} 
					});
			})
			.end(finish);
	},
	config: function(finish) {
		return finish(null, {
			stats: {
				enabled: true,
				commands: {
					top: 'top -Sb -n1',
					inxi: 'inxi -Fs -c0',
				},
			},
		});
	},
};
