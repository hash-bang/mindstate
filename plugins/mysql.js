var _ = require('lodash');
var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var colors = require('colors');
var fs = require('fs');

module.exports = {
	name: 'mysql',
	description: 'Backup all MySQL databases',
	backup: function(finish) {
		var cmd = _.get(mindstate.config, 'mysql.command', 'mysqldump --all-databases --skip-lock-tables --single-transaction --add-drop-table --skip-comments --set-charset --skip-extended-insert --order-by-primary');
		var outStream = fs.createWriteStream(mindstate.tempDir + '/mysql.sql');

		async()
			.use(asyncExec)
			.set('outFile', 'mysql.sql')
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[MySQL]'), 'Run', cmd);
				next();
			})
			.execDefaults({
				out: function(data) {
					outStream.write(data);
				},
			})
			.exec(cmd)
			.then(function(next) {
				outStream.end(next);
			})
			.end(finish);
	},
};
