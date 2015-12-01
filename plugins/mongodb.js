var _ = require('lodash');
var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var colors = require('colors');
var fs = require('fs');

module.exports = {
	name: 'mongodb',
	description: 'Backup all MongoDB databases',
	backup: function(finish) {
		var cmd = _.get(mindstate.config, 'mongodb.command', 'mongodump -o ' + mindstate.tempDir + '/mongodb');

		async()
			.use(asyncExec)
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[MongoDB]'), 'Run', cmd);
				next();
			})
			.exec(cmd)
			.end(finish);
	},
};
