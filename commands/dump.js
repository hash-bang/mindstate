module.exports = function(finish) {
	console.log(JSON.stringify(mindstate.config, null, '\t'));
	finish();
};
