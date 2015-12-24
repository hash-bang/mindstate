#!/usr/bin/env node

var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var program = require('commander');

program
	.version(require('./package.json').version)
	.option('-b, --backup', 'Perform a backup')
	.option('--dump', 'Dump config')
	.option('--dump-computed', 'Dump config (also showing default values)')
	.option('-l, --list', 'List server backups')
	.option('--setup', 'Initalize config')
	.option('-u, --update', 'Attempt to update the MindState client + plugins')
	.option('-d, --delete [item]', 'Delete a remote mindstate. Can be used multiple times', function(i, v) { v.push(i); return v }, [])
	.option('-v, --verbose', 'Be verbose. Specify multiple times for increasing verbosity', function(i, v) { return v + 1 }, 0)
	.option('--plugin [plugin]', 'Specify the plugins to use manually. Can be used multiple times', function(i, v) { v.push(i); return v }, [])
	.option('--no-color', 'Disable colors')
	.option('--no-clean', 'Do not delete temp directory after backup')
	.option('--no-upload', 'Skip the upload stage')
	.parse(process.argv);

// mindstate global object {{{
global.mindstate = require('./index');
global.mindstate.program = program; // Glue CLI interface to main model
global.mindstate.verbose = program.verbose;
// }}}

async()
	.then(function(next) {
		mindstate.functions.loadConfig(next, function(err) {
			console.log('LOAD');
			if (err == 'No INI file to load') {
				return next('No settings file found. Use `mindstate --setup` to set one up');
			} else {
				return next(err);
			}
		});
	})
	.then(function(next) {
		mindstate.functions.loadPlugins(next, function(module) {
			return !program.plugin.length || _.some(program.plugin, function(allowedPlugin) {
				return _.endsWith(module.pkg.name, allowedPlugin);
			});
		});
	})
	.then(function(next) {
		// Sanity checks {{{
		if (
			!mindstate.plugins.length && // No plugins AND
			( // We are trying to...
				program.backup ||
				program.restore
			)
		) return next('No plugins to run!');
		if (program.verbose) console.log('Using plugins:', mindstate.plugins.map(function(plugin) { return colors.cyan(plugin.name) }).join(', '));

		next();
		// }}}
	})
	.then(function(next) {
		if (!program.update) return next();
		mindstate.commands.update(next);
	})
	.then(function(next) {
		if (!program.dump) return next();
		mindstate.commands.dump(next);
	})
	.then(function(next) {
		if (!program.dumpComputed) return next();
		mindstate.commands.dumpComputed(next);
	})
	.then(function(next) {
		if (!program.setup) return next();
		mindstate.commands.setup(next);
	})
	.then(function(next) {
		if (!program.backup) return next();
		mindstate.commands.backup(next, {
			clean: program.clean,
			upload: program.upload,
		});
	})
	.then(function(next) {
		if (!program.list) return next();
		mindstate.commands.list(next);
	})
	.then(function(next) {
		if (!program.delete || !program.delete.length) return next();
		mindstate.commands.delete(next, {
			mindstates: program.delete,
		});
	})
	.end(function(err) {
		if (err) {
			console.log(colors.red('ERROR'), err.toString());
			return process.exit(1);
		}
		process.exit(0);
	});
