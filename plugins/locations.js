var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var copy = require('copy');

module.exports = {
	name: 'locations',
	description: 'Backup specified on-disk directories',
	backup: function(finish) {
		async()
			.then(function(next) {
				// Sanity checks {{{
				if (_.get(mindstate.config, 'locations.enabled', undefined) === false) {
					if (mindstate.program.verbose) console.log(colors.grey('Locations backup is disabled'));
					return next('SKIP');
				}

				if (!_.has(mindstate.config, 'locations.dir') || !mindstate.config.locations.dir.length) {
					if (mindstate.program.verbose) console.log(colors.grey('No additional locations to backup'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.forEach(mindstate.config.locations.dir, function(next, dir) {
				copy.dir(dir, mindstate.tempDir + '/files/' + dir, next);
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[File]'), colors.cyan(mindstate.config.locations.dir.length), 'paths copied');
				return next();
			})
			.end(finish);
	},
};
