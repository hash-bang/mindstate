var async = require('async-chainable');
var availableVersions = require('available-versions');
var cliTable = require('cli-table2');
var colors = require('chalk');
var moduleFinder = require('module-finder');
var npm = require('npm');

module.exports = function(finish, settings) {
	async()
		.set('modules', [])
		.then(mindstate.loadConfig)
		.then('modules', function(next) { // Find list of modules to update
			if (mindstate.verbose) console.log(colors.blue('[Update]'), 'Querying installed global modules');
			moduleFinder({
				local: true,
				global: true,
				filter: {
					keywords: {'$in': 'mindstate'},
				},
			})
				.then(function(modules) {
					if (mindstate.verbose) console.log(colors.blue('[Update]'), 'Found', modules.length, 'mindstate modules');
					next(null, modules);
				}, function(err) {
					next(err);
				});
		})
		.forEach('modules', function(nextModule, module) { // Glue .latestVersion property to item
			availableVersions({
				name: module.pkg.name,
				version: module.pkg.version,
			})
				.then(function(res) {
					module.pkg.versionLatest = res.versions && res.versions.length ? res.versions.slice(-1)[0] : module.pkg.version;
					nextModule();
				});
		})
		.then(function(next) {
			if (!mindstate.verbose) return next();

			// Render table {{{
			var table = new cliTable({
				head: ['Name', 'Current Version', 'Available', 'Action'],
				chars: mindstate.config.style.table.chars,
				style: mindstate.config.style.table.layout,
			});
			this.modules.forEach(function(module) {
				table.push([
					module.pkg.name,
					module.pkg.version,
					module.pkg.versionLatest,
					(module.pkg.version == module.pkg.versionLatest ? colors.grey('none') : colors.green('upgrade')),
				]);
			});
			console.log(table.toString());
			next();
			// }}}
		})
		.then(function(next) {
			var installable = this.modules
				.filter(function(module) { return (module.pkg.version != module.pkg.versionLatest) })
				.map(function(module) { return module.pkg.name });

			if (!installable.length) {
				console.log('Nothing to upgrade');
				return next();
			}

			npm.load({global: true}, function(err) {
				if (err) return next(err);
				if (mindstate.verbose) console.log(colors.blue('[NPM]'), 'install', installable.map(function(i) { return colors.cyan(i) }).join(' '));

				npm.commands.install(installable, function(err, data) {
					if (err) return next(err);
					if (mindstate.verbose > 2) console.log(colors.blue('[NPM]'), '>', data);
					next();
				});
			});
		})
		.end(finish);
};
