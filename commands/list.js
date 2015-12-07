var _ = require('lodash');
var async = require('async-chainable');
var cliTable = require('cli-table2');
var filesize = require('filesize');
var fs = require('fs');
var homedir = require('homedir');
var moment = require('moment');

module.exports = function(finish) {
	async()
		.then(mindstate.functions.loadConfig)
		.then('client', mindstate.functions.connect)
		.then('list', function(next) {
			this.client.list('/home/backups/backups', true, next);
		})
		.then(function(next) {
			// Render table {{{
			var table = new cliTable({
				head: ['#', 'Name', 'Date', 'Size'],
				chars: mindstate.config.style.table.chars,
				style: mindstate.config.style.table.layout,
			});

			var compiledPattern = new RegExp(mindstate.config.list.pattern);

			this.list
				.sort(function(a, b) {
					if (a.name > b.name) {
						return -1;
					} else if (a.name < b.name) {
						return 1;
					} else {
						return 0;
					}
				})
				.filter(function(item) {
					return (
						!mindstate.config.list.patternFilter ||
						compiledPattern.test(item.name)
					);
				})
				.forEach(function(file, offset) {
					table.push([
						(offset + 1),
						file.name,
						moment(Date.parse(file.date)).format(mindstate.config.style.date),
						filesize(file.size),
					]);
				});

			console.log(table.length ? table.toString() : 'Nothing to display');
			next();
			// }}}
		})
		.end(finish);
};
