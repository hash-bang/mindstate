var _ = require('lodash');
var async = require('async-chainable');
var cliTable = require('cli-table2');
var colors = require('chalk');
var filesize = require('filesize');
var moment = require('moment');

module.exports = function(finish, settings) {
	async()
		// Defaults {{{
		.then(function(next) {
			_.defaults(settings, {
				nagios: {
					warning: 4,
					critical: 14,
				},
			});
			next();
		})
		// }}}
		// Calculate date ranges {{{
		.then('dateRanges', function(next) {
			next(null, {
				warning: moment().subtract(settings.nagios.warning, 'days').toDate(),
				critical: moment().subtract(settings.nagios.critical, 'days').toDate(),
			});
		})
		// }}}
		// Sanity checks {{{
		.then(function(next) {
			if (!mindstate.program.args.length) return next('Required server missing');
			next();
		})
		// }}}
		.then(mindstate.functions.loadConfig)
		.then('client', mindstate.functions.connect)
		// Fetch list of mindstates {{{
		.then('list', function(next) {
			mindstate.functions.list(next, this.client, {
				server: mindstate.program.args[0],
				sort: 'meta.date',
				meta: true,
			});
		})
		// }}}
		// Calculate latest backup {{{
		.then('latest', function(next) {
			if (!this.list.length) return next('No matching backups found');
			next(null, this.list[0]);
		})
		// }}}
		// Calculate whether any fall within range {{{
		.then('status', function(next) {
			if (this.latest.meta.date <= this.dateRanges.critical) {
				next(null, 'CRIT');
			} else if (this.latest.meta.date <= this.dateRanges.warning) {
				next(null, 'WARN');
			} else {
				next(null, 'OK');
			}
		})
		// }}}
		// End {{{
		.end(function(err) {
			if (err) {
				console.log('Mindstate ERROR - ' + err.toString());
				process.exit(3);
			}

			console.log('Mindstate ' + this.status + ' - ' + moment(this.latest.meta.date).format('YYYY-MM-DD HH:mm:ss') + ' size: ' + filesize(this.latest.size));
			switch (this.status) {
				case 'OK': process.exit(0);
				case 'WARN': process.exit(1);
				case 'CRIT': process.exit(2);
				default: process.exit(3);
			}
		});
		// }}}
};
