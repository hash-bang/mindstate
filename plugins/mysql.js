var _ = require('lodash');
var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var colors = require('colors');
var fs = require('fs');
var which = require('which');

module.exports = {
	name: 'mysql',
	description: 'Backup all MySQL databases',
	backup: function(finish, workspace) {
		var outStream = fs.createWriteStream(workspace.dir + '/databases.sql');

		async()
			.use(asyncExec)
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.mysql.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('MySQL backup is disabled'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.then('binPath', function(next) {
				// Check for binary {{{
				which('mysqldump', function(err) {
					if (err) {
						if (mindstate.program.verbose) console.log(colors.grey('`mysqldump` is not in PATH'));
						return next('SKIP');
					}
					next();
				});
				// }}}
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.blue('[MySQL]'), 'Run', mindstate.config.mysql.command);
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
