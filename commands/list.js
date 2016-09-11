var _ = require('lodash');
var async = require('async-chainable');
var cliTable = require('cli-table2');
var filesize = require('filesize');
var fs = require('fs');
var moment = require('moment');

module.exports = function(finish) {
	async()
		.then(mindstate.functions.loadConfig)
		.then('client', mindstate.functions.connect)
		.then('list', function(next) {
			mindstate.functions.list(next, this.client, {
				sort: 'name',
			});
		})
		// Render table {{{
		.then(function(next) {
			var table = new cliTable({
				head: ['#', 'Name', 'Date', 'Size'],
				chars: mindstate.config.style.table.chars,
				style: mindstate.config.style.table.layout,
			});

			this.list.forEach(function(file, offset) {
				table.push([
					(offset + 1),
					file.name,
					moment(file.date).format(mindstate.config.style.date),
					filesize(file.size),
				]);
			});

			console.log(table.length ? table.toString() : 'Nothing to display');
			next();
		})
		// }}}
		.end(finish);
};
