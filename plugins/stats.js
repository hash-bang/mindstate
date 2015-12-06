var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var colors = require('colors');
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
				next();
				// }}}
			})
			.then('binPath', function(next) {
				// Check for binary {{{
				which('top', function(err) {
					if (err) {
						if (mindstate.program.verbose) console.log(colors.grey('`top` is not in PATH'));
						return next('SKIP');
					}
					next();
				});
				// }}}
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[Stats]'), 'Run', mindstate.config.stats.command);
				next();
			})
			.exec(mindstate.config.stats.command)
			.end(finish);
	},
	config: function(finish) {
		return finish(null, {
			stats: {
				enabled: true,
				command: 'top -Sb | head -n 30',
			},
		});
	},
};
