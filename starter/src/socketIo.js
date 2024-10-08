import db from 'db';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import config from 'app-config';
import logger from 'logger';

export default (server) => {
  const io = new Server(server);

  const pubClient = createClient({ url: config.redis.url });
  const subClient = pubClient.duplicate();

  io.adapter(createAdapter(pubClient, subClient));

  const getCookie = (cookieString, name) => {
    const value = `; ${cookieString}`;
    const parts = value.split(`; ${name}=`);

    if (parts.length === 2) {
      return parts.pop().split(";").shift();
    }

    return null;
  };

  // #TODO get user using accessToken
  const getUserData = async (socket) => {
    const accessToken = getCookie(
      socket.handshake.headers.cookie,
      "access_token"
    ) || '';

    console.log('socket: cookie access token', accessToken[0], accessToken[1], accessToken[2]);

    let tokenDoc = null;

    if (!accessToken) {
      logger.info(
        "Note: socket io anonymous auth. Add user authentication in socketIoService"
      );
    } else {
      tokenDoc = await db.services.tokens.findOne({ token: accessToken });
    }

    return {
      _id: tokenDoc?.user?._id || "anonymous",
    };
  };

  io.use(async (socket, next) => {
    const userData = await getUserData(socket);

    if (userData) {
      // eslint-disable-next-line no-param-reassign
      socket.handshake.data = {
        userId: userData.userId,
      };

      return next();
    }

    return next(new Error("token is invalid"));
  });

  function checkAccessToRoom(roomId, data) {
    let result = false;
    const [roomType, id] = roomId.split("-");

    switch (roomType) {
      case "user":
        result = id === data.userId;
        break;
      default:
        result = true;
    }

    return result;
  }

  io.on("connection", (client) => {
    client.on("subscribe", (roomId) => {
      const { userId } = client.handshake.data;
      // const hasAccessToRoom = checkAccessToRoom(roomId, { userId });
      
      const hasAccessToRoom = true;

      if (hasAccessToRoom) {
        client.join(roomId);
      }
    });

    client.on("unsubscribe", (roomId) => {
      client.leave(roomId);
    });
  });

  console.log(`Socket.io server is started on app instance`);
};
