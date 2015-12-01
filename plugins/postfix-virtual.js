var async = require('async-chainable');
var colors = require('colors');
var fs = require('fs');

module.exports = {
	name: 'postfix-virtual',
	description: 'Backup PostFix\'s virtuals config',
	backup: function(finish) {
		async()
			.set('file', '/etc/postfix/virtual')
			.set('outFile', 'postfix-virtual')
			.then('stat', function(next) {
				fs.stat(this.file, function(err, stat) {
					if (err) return next('SKIP'); // Not found
					return next(null, stat);
				});
			})
			.then(function(next) {
				if (mindstate.program.verbose) console.log(colors.grey('Backup', this.file));
				copy('/etc/postfix/virtual', mindstate.tempDir + '/' + this.outFile, next);
			})
			.end(finish);
	},
};
