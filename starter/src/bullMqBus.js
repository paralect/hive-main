const config = require('app-config');
const bullMq = require('./bullMq');
const queue = bullMq.Queue(`database-${config.env}`);

let handlers = {};

module.exports = {
  on(eventName, handler) {
    console.log('registering', eventName);

    handlers[eventName] = handlers[eventName] || [];
    handlers[eventName].push(handler);
  },
  emit(eventName, data) {
    queue.add(eventName, data);
  }
}

bullMq.Worker(`database-${config.env}`, async ({ name: eventName, data }) => {
  await Promise.all((handlers[eventName] || []).map(h => h(data)));
});