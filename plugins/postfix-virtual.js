var async = require('async-chainable');
var colors = require('colors');
var fs = require('fs');

module.exports = {
	name: 'postfix-virtual',
	description: 'Backup PostFix\'s virtuals config',
	backup: function(finish) {
		async()
			.set('outFile', 'postfix-virtual')
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.postfixVirtual.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('PostFix-Virtual backup is disabled'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.then('stat', function(next) {
				fs.stat(mindstate.config.postfixVirtual.path, function(err, stat) {
					if (err) return next('SKIP'); // Not found
					return next(null, stat);
				});
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.grey('Backup', mindstate.config.postfixVirtual.path));
				copy('/etc/postfix/virtual', mindstate.tempDir + '/' + this.outFile, next);
			})
			.end(finish);
	},
	config: function(finish) {
		return finish(null, {
			postfixVirtual: {
				enabled: true,
				path: '/etc/postfix/virtual',
			},
		});
	},
};
