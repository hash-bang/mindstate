var _ = require('lodash');
var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var colors = require('colors');
var fs = require('fs');

module.exports = {
	name: 'mysql',
	description: 'Backup all MySQL databases',
	backup: function(finish) {
		var outStream = fs.createWriteStream(mindstate.tempDir + '/mysql.sql');

		async()
			.use(asyncExec)
			.set('outFile', 'mysql.sql')
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.mysql.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('MySQL backup is disabled'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[MySQL]'), 'Run', cmd);
				next();
			})
			.execDefaults({
				out: function(data) {
					outStream.write(data);
				},
			})
			.exec(mindstate.config.mysql.command)
			.then(function(next) {
				outStream.end(next);
			})
			.end(finish);
	},
	config: function(finish) {
		return finish(null, {
			mysql: {
				enabled: true,
				command: 'mysqldump --all-databases --skip-lock-tables --single-transaction --add-drop-table --skip-comments --set-charset --skip-extended-insert --order-by-primary',
			},
		});
	},
};
