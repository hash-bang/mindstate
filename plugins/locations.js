var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var copy = require('copy');

module.exports = {
	name: 'locations',
	description: 'Backup specified on-disk directories',
	backup: function(finish, workspace) {
		async()
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.locations.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('Locations backup is disabled'));
					return next('SKIP');
				}

				if (!mindstate.config.locations.dir.length) {
					if (mindstate.program.verbose) console.log(colors.grey('No additional locations to backup'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.forEach(mindstate.config.locations.dir, function(next, dir) {
				copy.dir(dir, workspace.dir + '/' + dir, next);
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[Locations]'), colors.cyan(mindstate.config.locations.dir.length), 'paths copied');
				return next();
			})
			.end(finish);
	},
	config: function(finish) {
		return finish(null, {
			locations: {
				enabled: true,
				dir: [],
			},
		});
	},
};
