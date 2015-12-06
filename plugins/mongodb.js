var _ = require('lodash');
var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var colors = require('colors');
var fs = require('fs');
var which = require('which');

module.exports = {
	name: 'mongodb',
	description: 'Backup all MongoDB databases',
	backup: function(finish) {
		async()
			.use(asyncExec)
			.then('binPath', function(next) {
				which('mongodump', next);
			})
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.mongodb.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('MongoDB backup is disabled'));
					return next('SKIP');
				}
				if (!this.binPath) {
					if (mindstate.program.verbose) console.log(colors.grey('`mongodump` is not in PATH'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[MongoDB]'), 'Run', mindstate.config.mongodb.command);
				next();
			})
			.exec(mindstate.config.mongodb.command)
			.end(finish);
	},
	config: function(finish) {
		return finish(null, {
			mongodb: {
				enabled: true,
				command: 'mongodump -o {{tempDir}}/mongodb',
			},
		});
	},
};
