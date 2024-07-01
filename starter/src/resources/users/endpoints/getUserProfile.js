module.exports.handler = async (ctx) => {
  const { userId } = ctx.params;
  const user = await userService.findOne({ _id: userId });
  ctx.body = user;
};

const Joi = require("joi");

module.exports.requestSchema = Joi.object({
  userId: Joi.string().required(),
});

module.exports.endpoint = {
  method: "GET",
  url: "/profile/:userId",
};
