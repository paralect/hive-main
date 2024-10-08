import monk from 'monk';
import { EventEmitter } from 'events';
import _ from 'lodash';
import MongoQueryService from './mongo-query-service';
import MongoServiceError from './mongo-service-error';

const defaultOptions = {
  addCreatedOnField: true,
  addUpdatedOnField: true,
  useStringId: true,
  validate: undefined,
  emitter: undefined,
  secureFields: ['verySecureField'],

  onBeforeCreated: ({ docs }) => docs,
};

class MongoService extends MongoQueryService {
  constructor(collection, options = {}) {
    super(collection, options);
    _.defaults(this._options, defaultOptions);

    this._bus = this._options.emitter || new EventEmitter();

    this.generateId = () => monk.id().toHexString();

    this.atomic = {
      bulkWrite: collection.bulkWrite,
      createIndex: collection.createIndex,
      drop: collection.drop,
      dropIndex: collection.dropIndex,
      dropIndexes: collection.dropIndexes,
      findOneAndDelete: collection.findOneAndDelete,
      findOneAndUpdate: collection.findOneAndUpdate,
      insert: collection.insert,
      remove: collection.remove,
      update: collection.update,
    };

    collection.manager
      .executeWhenOpened()
      .then(async () => {
        await collection.manager._db.command({ create: collection.name });
      })
      .catch((error) => {
        // a collection already exists
        if (error.code !== 48) {
          throw error;
        }
      });
  }

  static _deepCompare(data, initialData, properties) {
    let changed = false;

    if (Array.isArray(properties)) {
      changed =
        _.find(properties, (prop) => {
          const value = _.get(data, prop);
          const initialValue = _.get(initialData, prop);

          return !_.isEqual(value, initialValue);
        }) !== undefined;
    } else {
      Object.keys(properties).forEach((prop) => {
        if (changed) return;

        const value = _.get(data, prop);
        const initialValue = _.get(initialData, prop);

        if (
          _.isEqual(value, properties[prop]) &&
          !_.isEqual(initialValue, properties[prop])
        ) {
          changed = true;
        }
      });
    }

    return changed;
  }

  async _validate(entity) {
    if (this._options.validate) {
      const { value, error } = await this._options.validate(entity);

      if (error) {
        console.log("Schema Error", error);

        throw new MongoServiceError(
          MongoServiceError.INVALID_SCHEMA,
          `Document schema is invalid: ${JSON.stringify(error, null, 2)}`,
          error
        );
      }

      return value;
    }

    return entity;
  }

  emit(eventName, event) {
    return this._bus.emit(`${this._collection.name}:${eventName}`, event);
  }

  once(eventName, handler) {
    return this._bus.once(`${this._collection.name}:${eventName}`, handler);
  }

  on(eventName, handler) {
    return this._bus.on(`${this._collection.name}:${eventName}`, handler);
  }

  onUpdated(fieldNames = [], handler = (e) => { }) {
    return this.on(`${this._collection.name}:${eventName}`, (event) => {
      const { doc, prevDoc } = event;

      let isFieldChanged = false;

      if (_.isArray(fieldNames)) {
        _.forEach(fieldNames, (fieldName) => {
          if (!_.isEqual(doc[fieldName], prevDoc[fieldName])) {
            isFieldChanged = true;
            return false; // break loop
          }

          return true;
        });
      } else if (_.isObject(fieldNames)) {
        const fieldName = Object.keys(fieldNames)[0];

        if (_.isEqual(_.get(doc, fieldName), fieldNames[fieldName]) && !_.isEqual(_.get(doc, fieldName), _.get(prevDoc, fieldName))) {
          isFieldChanged = true;
        }
      }

      if (isFieldChanged) handler(event);
    });
  }

  async create(objs, options = {}) {
    const entities = _.isArray(objs) ? objs : [objs];

    let created = await Promise.all(
      entities.map(async (doc) => {
        const entity = _.cloneDeep(doc);

        if (this._options.useStringId && !entity._id)
          entity._id = this.generateId();
        if (this._options.addCreatedOnField && !entity.createdOn) {
          entity.createdOn = new Date().toISOString();
        }
        const validated = await this._validate(entity);

        return validated;
      })
    );

    created = await this._options.onBeforeCreated({ docs: created });

    await this._collection.insert(created, options);

    created.forEach((doc) => {
      this._bus.emit(`${this._collection.name}:created`, {
        doc,
      });
    });

    created = created.map(doc => {
      return _.omit(doc, options.isIncludeSecureFields ? [] : this._options.secureFields);
    })

    return created.length > 1 ? created : created[0];
  }

  async updateOne(query, updateFn, options = {}) {
    if (!_.isFunction(updateFn)) {
      throw new MongoServiceError(
        MongoServiceError.INVALID_ARGUMENT,
        `updateOne: second argument is invalid. Expected a function but got ${typeof updateFn}`
      );
    }

    const findOptions = { isIncludeSecureFields: true };
    if (options.session) findOptions.session = options.session;
    const doc = await this.findOne(query, findOptions);
    if (!doc) {
      throw new MongoServiceError(
        MongoServiceError.NOT_FOUND,
        `updateOne: document not found. Query: ${JSON.stringify(query)}`
      );
    }

    let entity = _.cloneDeep(doc);

    if (this._options.addUpdatedOnField)
      entity.updatedOn = new Date().toISOString();
    entity = await updateFn(entity);
    let updated = await this._validate(entity);

    await this._collection.update(
      { ...query, _id: doc._id },
      { $set: updated },
      options
    );


    this._bus.emit(`${this._collection.name}:updated`, {
      doc: updated,
      prevDoc: doc,
    });

    updated = _.omit(updated, options.isIncludeSecureFields ? [] : this._options.secureFields);

    return updated;
  }

  async updateMany(query, updateFn, options = {}) {
    if (!_.isFunction(updateFn)) {
      throw new MongoServiceError(
        MongoServiceError.INVALID_ARGUMENT,
        `updateMany: second argument is invalid. Expected a function but got ${typeof updateFn}`
      );
    }

    const findOptions = { isIncludeSecureFields: true };
    if (options.session) findOptions.session = options.session;
    const { results: docs } = await this.find(query, findOptions);
    if (docs.length === 0) return [];

    let updated = await Promise.all(
      docs.map(async (doc) => {
        let entity = _.cloneDeep(doc);

        if (this._options.addUpdatedOnField)
          entity.updatedOn = new Date().toISOString();
        entity = await updateFn(entity);
        const validated = await this._validate(entity);

        return validated;
      })
    );

    await Promise.all(
      updated.map((doc) =>
        this._collection.update(
          { ...query, _id: doc._id },
          { $set: doc },
          options
        )
      )
    );

    updated.forEach((doc, index) => {
      this._bus.emit(`${this._collection.name}:updated`, {
        doc,
        prevDoc: docs[index],
      });
    });

    updated = updated.map(doc => _.omit(doc, options.isIncludeSecureFields ? [] : this._options.secureFields));

    return updated;
  }

  async remove(query, options = {}) {
    const findOptions = {};
    if (options.session) findOptions.session = options.session;
    const removed = await this.find(query, findOptions);
    await this._collection.remove(query, options);

    removed.results.forEach((doc) => {
      this._bus.emit(`${this._collection.name}:removed`, {
        doc,
      });
    });

    return removed;
  }

  async performTransaction(transactionFn, options = {}) {
    if (!_.isFunction(transactionFn)) {
      throw new MongoServiceError(
        MongoServiceError.INVALID_ARGUMENT,
        `performTransaction: first argument is invalid. Expected a function but got ${typeof transactionFn}`
      );
    }

    await this._collection.manager.executeWhenOpened();

    const session = this._collection.manager._client.startSession(options);

    try {
      await session.withTransaction(transactionFn);
    } catch (error) {
      session.endSession();
      throw error;
    }
  }
}

export default MongoService;
