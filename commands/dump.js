module.exports = function(finish, settings) {
	console.log(JSON.stringify(mindstate.config, null, '\t'));
	finish();
};
