#!/usr/bin/env node

var _ = require('lodash');
var async = require('async-chainable');
var colors = require('chalk');
var program = require('commander');

program
	.version(require('./package.json').version)
	.option('-b, --backup', 'Perform a backup')
	.option('--dump', 'Dump config')
	.option('--dump-computed', 'Dump config (showing values after internal defaults merging + mustache processing)')
	.option('-l, --list', 'List server backups')
	.option('--setup', 'Initalize config')
	.option('-u, --update', 'Attempt to update the MindState client + plugins')
	.option('-d, --delete [item]', 'Delete a remote mindstate. Can be used multiple times', function(i, v) { v.push(i); return v }, [])
	.option('-v, --verbose', 'Be verbose. Specify multiple times for increasing verbosity', function(i, v) { return v + 1 }, 0)
	.option('--debug', 'Turn on debugging. Disables global plugin loads')
	.option('--plugin [plugin]', 'Specify the plugins to use manually. Can be used multiple times', function(i, v) { v.push(i); return v }, [])
	.option('--no-color', 'Disable colors')
	.option('--no-clean', 'Do not delete temp directory after backup')
	.option('--no-upload', 'Skip the upload stage')
	.parse(process.argv);

// global.mindstate object {{{
global.mindstate = require('./index');
global.mindstate.program = program; // Glue CLI interface to main model
global.mindstate.verbose = program.verbose;

if (program.debug) global.mindstate.loadPluginsGlobal = false;
// }}}

async()
	// Load config {{{
	.then(function(next) {
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Loading INI config...');
		mindstate.functions.loadConfig(function(err) {
			if (err == 'No INI file to load') {
				// Disallow certain operations if there is no INI file
				if (
					program.backup ||
					program.list ||
					program.delete.length
				) {
					return next('No settings file found. Use `mindstate --setup` to set one up');
				} else {
					if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'No INI file present but not needed for this operation anyway');
					// There is no INI file but we (probably) dont need it for this operation anyway
					return next();
				}
			} else {
				return next(err);
			}
		});
	})
	// }}}
	// Enact client only options {{{
	.then(function(next) {
		// Apply process.env.PATH if some are missing {{{
		if (_.has(mindstate.config, 'client.paths') && mindstate.config.client.paths.length) {
			var hasPaths = process.env.PATH ? process.env.PATH.split(':') : [];
			var addPaths = mindstate.config.client.paths.filter(function(wantPath) {
				return !_.includes(hasPaths, wantPath);
			});
			if (addPaths.length) {
				if (mindstate.verbose > 1) console.log(colors.blue('[Mindstate]'), 'Items missing from PATH: ' + addPaths.map(function(i) { return colors.cyan(i) }).join(', '));
				process.env.PATH += ':' + addPaths.join(':');
				if (mindstate.verbose > 1) console.log(colors.blue('[Mindstate]'), 'PATH modified to ' + colors.cyan(process.env.PATH));
			}
		}
		// }}}
		next();
	})
	// }}}
	// Load plugins {{{
	.then(function(next) {
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Loading plugins...');
		mindstate.functions.loadPlugins(next, function(module) {
			return !program.plugin.length || _.some(program.plugin, function(allowedPlugin) {
				var usePlugin = _.endsWith(module.pkg.name, allowedPlugin);
				if (!usePlugin && mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Filtering out plugin', colors.cyan(module.pkg.name));
				return usePlugin;
			});
		});
	})
	// }}}
	// Sanity checks {{{
	.then(function(next) {
		if (
			!mindstate.plugins.length && // No plugins AND
			( // We are trying to...
				program.backup ||
				program.restore
			)
		) return next('No plugins to run!');
		if (mindstate.verbose) console.log(colors.blue('[Mindstate]'), 'Using plugins:', mindstate.plugins.map(function(plugin) { return colors.cyan(plugin.name) }).join(', '));

		next();
	})
	// }}}
	// Perform actions in a logical order (multiple actions can be performed so we need to figure out what is most optimal) {{{
	.then(function(next) {
		if (!program.update) return next();
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Performing operation:', colors.cyan('update'));
		mindstate.commands.update(next);
	})
	.then(function(next) {
		if (!program.dump) return next();
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Performing operation:', colors.cyan('dump'));
		mindstate.commands.dump(next);
	})
	.then(function(next) {
		if (!program.dumpComputed) return next();
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Performing operation:', colors.cyan('dumpComputed'));
		mindstate.commands.dumpComputed(next);
	})
	.then(function(next) {
		if (!program.setup) return next();
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Performing operation:', colors.cyan('setup'));
		mindstate.commands.setup(next);
	})
	.then(function(next) {
		if (!program.backup) return next();
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Performing operation:', colors.cyan('backup'));
		mindstate.commands.backup(next, {
			clean: program.clean,
			upload: program.upload,
		});
	})
	.then(function(next) {
		if (!program.list) return next();
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Performing operation:', colors.cyan('list'));
		mindstate.commands.list(next);
	})
	.then(function(next) {
		if (!program.delete || !program.delete.length) return next();
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Performing operation:', colors.cyan('delete'));
		mindstate.commands.delete(next, {
			mindstates: program.delete,
		});
	})
	// }}}
	// End {{{
	.end(function(err) {
		if (mindstate.verbose > 2) console.log(colors.blue('[Mindstate]'), 'Done');
		if (err) {
			console.log(colors.red('ERROR'), err.toString());
			return process.exit(1);
		}
		process.exit(0);
	});
	// }}}
