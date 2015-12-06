var _ = require('lodash');
var async = require('async-chainable');
var cliTable = require('cli-table2');
var fs = require('fs');
var homedir = require('homedir');
var moment = require('moment');
var sftpjs = require('sftpjs');

module.exports = function(finish) {
	async()
		.then(mindstate.functions.loadConfig)
		.then('privateKey', function(next) {
			if (mindstate.config.server.password) return next(); // Use plaintext password instead

			async()
				.set('keyPath', homedir() + '/.ssh/id_rsa')
				.then('keyStat', function(next) {
					fs.stat(this.keyPath, next);
				})
				.then('keyContent', function(next) {
					fs.readFile(this.keyPath, next);
				})
				.end(function(err) {
					if (err) return next(null, undefined); // Key not found or failed to read
					if (mindstate.program.verbose) console.log(colors.grey('Using local private key'));
					next(null, this.keyContent);
				});
		})
		.then(function(next) {
			this.client = sftpjs()
				.on('error', next)
				.on('ready', function() {
					if (mindstate.program.verbose) console.log(colors.grey('SSH host connected'));
					next();
				})
				.connect({
					host: 'zapp.mfdc.biz',
					username: 'backups',
					password: _.get(mindstate.config, 'server.password', undefined),
					privateKey: this.privateKey || undefined,
					debug: mindstate.program.verbose ? function(d) { // Install debugger to spew SSH output if in verbose mode
						console.log(colors.grey('[SSH]', d));
					} : undefined,
				});
		})
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
						file.size,
					]);
				});

			console.log(table.length ? table.toString() : 'Nothing to display');
			next();
			// }}}
		})
		.end(finish);
};
