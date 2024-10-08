import { z } from 'zod';

export const endpoint = {
  method: "put",
  url: "/trigger-scheduler-handler",
};

export const requestSchema = z.object({
  name: z.string(),
});

export const handler = async (ctx) => {
  const { name } = ctx.validatedData;

  const schedulerHandler = await (import(`${process.env.HIVE_SRC}/scheduler/handlers/${name}`));

  try {
    const data = await schedulerHandler.handler();

    ctx.body = {
      ok: true,
      data,
    };
  } catch (err) {
    ctx.body = {
      ok: false,
      err: err.message,
    };
  }
};

export const middlewares = ['allowNoAuth'];
