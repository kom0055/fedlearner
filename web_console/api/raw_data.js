const router = require('@koa/router')();
const { Op } = require('sequelize');
const SessionMiddleware = require('../middlewares/session');
const checkParseJson = require('../utils/check_parse_json');
const k8s = require('../libs/k8s');
const getConfig = require('../utils/get_confg');
const { RawData, Federation } = require('../models');
const { portalGenerateYaml } = require('../utils/job_builder');

const config = getConfig({
  NAMESPACE: process.env.NAMESPACE,
});
const namespace = config.NAMESPACE;

router.get('/api/v1/raw_datas', SessionMiddleware, async (ctx) => {
  const data = await RawData.findAll({ order: [['created_at', 'DESC']] });
  ctx.body = { data };
});

router.get('/api/v1/raw_data/:id', SessionMiddleware, async (ctx) => {
  const { id } = ctx.params;
  const rawData = await RawData.findByPk(id, {
    include: 'federation',
  });
  if (!rawData) {
    ctx.status = 404;
    ctx.body = {
      error: 'RawData not found',
    };
    return;
  }
  let flapp = {};
  if (rawData.submited) {
    flapp = (await k8s.getFLApp(namespace, rawData.name)).flapp;
  }
  ctx.body = {
    data: {
      ...flapp,
      localdata: rawData,
    },
  };
});

router.post('/api/v1/raw_data', SessionMiddleware, async (ctx) => {
  const { name, federation_id, input, output, comment, output_partition_num, data_portal_type } = ctx.request.body;

  if (!(/^[a-zA-Z\d-]+$/.test(name))) {
    ctx.status = 400;
    ctx.body = {
      error: 'name can only contain letters/numbers/-',
    };
    return;
  }

  if (!(/^\d+$/.test(output_partition_num))) {
    ctx.status = 400;
    ctx.body = {
      error: 'output_partition_num must be int',
    };
    return;
  }

  const [context_pass, context] = checkParseJson(ctx.request.body.context);
  if (!context_pass) {
    ctx.status = 400;
    ctx.body = {
      error: 'context must be json',
    };
    return;
  }
  const federation = await Federation.findByPk(federation_id);
  if (!federation) {
    ctx.status = 400;
    ctx.body = {
      error: 'Federation not exists',
    };
    return;
  }

  const rawData = { name, federation_id, input, output, context, comment, output_partition_num, data_portal_type };

  try {
    portalGenerateYaml(federation, rawData);
  } catch (e) {
    ctx.status = 400;
    ctx.body = {
      error: 'context not well-formed',
    };
    return;
  }

  const [data, created] = await RawData.findOrCreate({
    paranoid: false,
    where: {
      name: { [Op.eq]: name },
    },
    defaults: {
      ...rawData,
      user_id: ctx.session.user.id,
    },
  });

  if (!created) {
    ctx.status = 422;
    ctx.body = {
      error: 'RawData already exists',
    };
    return;
  }

  ctx.body = { data };
});

router.post('/api/v1/raw_data/:id/submit', SessionMiddleware, async (ctx) => {
  const { id } = ctx.params;
  const rawData = await RawData.findByPk(id, {
    include: 'federation',
  });
  if (!rawData) {
    ctx.status = 404;
    ctx.body = {
      error: 'RawData not found',
    };
    return;
  }

  if (rawData.submited) {
    ctx.status = 400;
    ctx.body = {
      error: 'RawData is submited',
    };
    return;
  }

  const yaml = portalGenerateYaml(rawData.federation, rawData);

  await k8s.createFLApp(namespace, yaml);

  rawData.submited = true;

  const data = await rawData.save();

  ctx.body = { data };
});

router.post('/api/v1/raw_data/:id/delete_job', SessionMiddleware, async (ctx) => {
  const { id } = ctx.params;
  const rawData = await RawData.findByPk(id);
  if (!rawData) {
    ctx.status = 404;
    ctx.body = {
      error: 'RawData not found',
    };
    return;
  }

  if (!rawData.submited) {
    ctx.status = 400;
    ctx.body = {
      error: 'RawData is unsubmited',
    };
    return;
  }

  await k8s.deleteFLApp(namespace, rawData.name);

  rawData.submited = false;

  const data = await rawData.save();

  ctx.body = { data };
});

router.delete('/api/v1/raw_data/:id', SessionMiddleware, async (ctx) => {
  // TODO: just owner can delete
  const { id } = ctx.params;
  const data = await RawData.findByPk(id);

  if (!data) {
    ctx.status = 404;
    ctx.body = {
      error: 'RawData not found',
    };
    return;
  }

  if (data.submited) {
    await k8s.deleteFLApp(namespace, data.name);
  }

  await data.destroy();

  ctx.body = { data };
});

module.exports = router;
