import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

// 云托管会注入 MYSQL_URL，自动切换 MySQL
// 本地开发用 .env 里的 DATABASE_URL=file:./xinxi.db
if (process.env.MYSQL_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MYSQL_URL
}

const prisma = new PrismaClient()
const JWT_SECRET = process.env.JWT_SECRET || 'xinxi-dev-secret'
const WX_APPID = process.env.WX_APPID || ''
const WX_SECRET = process.env.WX_SECRET || ''

const app = Fastify({ logger: true })
await app.register(cors)

// ============================================================
// 微信登录
// ============================================================
app.post('/api/login', async (req, reply) => {
  const { code, nickname, avatar } = req.body

  // 开发模式：跳过微信 code2session
  let openid = code
  if (WX_APPID && WX_SECRET && code) {
    try {
      const r = await fetch(
        `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`
      )
      const data = await r.json()
      if (data.openid) openid = data.openid
      else return reply.code(400).send({ error: '登录失败', detail: data })
    } catch (e) {
      // 开发模式 fallback
    }
  }

  let user = await prisma.user.findUnique({ where: { openid } })
  if (!user) {
    user = await prisma.user.create({
      data: { openid, nickname: nickname || '小守', avatar: avatar || '' }
    })
  } else if (nickname) {
    user = await prisma.user.update({ where: { id: user.id }, data: { nickname, avatar } })
  }

  const token = jwt.sign({ userId: user.id, openid }, JWT_SECRET, { expiresIn: '30d' })
  return { token, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, mbti: user.mbti, relation: user.relation } }
})

// ============================================================
// 认证中间件
// ============================================================
async function auth(req, reply) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer '))
    return reply.code(401).send({ error: '未登录' })
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET)
    req.userId = payload.userId
  } catch {
    return reply.code(401).send({ error: '登录过期' })
  }
}

// ============================================================
// 用户
// ============================================================
app.get('/api/user/me', { preHandler: auth }, async (req) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } })
  return { id: user.id, nickname: user.nickname, avatar: user.avatar, mbti: user.mbti, relation: user.relation }
})

app.put('/api/user/me', { preHandler: auth }, async (req) => {
  const { nickname, avatar, mbti, relation } = req.body
  const user = await prisma.user.update({ where: { id: req.userId }, data: { nickname, avatar, mbti, relation } })
  return user
})

// ============================================================
// 心情记录
// ============================================================
app.post('/api/moods', { preHandler: auth }, async (req) => {
  const { mood, lakeState, note } = req.body
  const m = await prisma.mood.create({
    data: { userId: req.userId, mood, lakeState: lakeState || 'mirror', note }
  })
  return m
})

app.get('/api/moods', { preHandler: auth }, async (req) => {
  const { limit = 20, offset = 0 } = req.query
  const moods = await prisma.mood.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: Number(limit),
    skip: Number(offset)
  })
  return moods
})

// ============================================================
// 湖面状态（基于今日心情推算）
// ============================================================
app.get('/api/lake-state', { preHandler: auth }, async (req) => {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const moods = await prisma.mood.findMany({
    where: { userId: req.userId, createdAt: { gte: today } },
    orderBy: { createdAt: 'desc' }
  })
  const state = moods.length >= 5 ? 'ripples'
    : moods.length >= 2 ? 'breeze'
    : moods.length >= 1 ? 'breeze'
    : 'mirror'

  const moodList = ['平静', '开心', '疲惫', '焦虑', '低落', '充满活力']
  const insight = moods.length === 0
    ? '今天还没有投下石子，湖面如镜，波澜不惊。'
    : moods.some(m => m.mood === '低落' || m.mood === '焦虑')
    ? '湖面有些波澜——今天的心情不是风平浪静，但涟漪终会散去。'
    : '今日湖面映照着你的心情，微风拂过，泛起浅浅涟漪。'

  return { state, moods, insight }
})

// ============================================================
// 羁绊
// ============================================================
app.get('/api/bonds', { preHandler: auth }, async (req) => {
  return prisma.bond.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'asc' } })
})

app.post('/api/bonds', { preHandler: auth }, async (req) => {
  const { name, relation, type, silent } = req.body
  return prisma.bond.create({
    data: { userId: req.userId, name, relation, type: type || '相伴', silent: silent || false }
  })
})

app.delete('/api/bonds/:id', { preHandler: auth }, async (req) => {
  await prisma.bond.delete({ where: { id: req.params.id } })
  return { ok: true }
})

// ============================================================
// 消息 / 回响
// ============================================================
app.get('/api/messages', { preHandler: auth }, async (req) => {
  return prisma.message.findMany({
    where: { toUserId: req.userId },
    orderBy: { createdAt: 'desc' },
    include: { fromUser: { select: { id: true, nickname: true, avatar: true } } }
  })
})

app.post('/api/messages', { preHandler: auth }, async (req) => {
  const { toUserId, text } = req.body
  return prisma.message.create({ data: { fromUserId: req.userId, toUserId, text } })
})

app.put('/api/messages/:id/accept', { preHandler: auth }, async (req) => {
  await prisma.message.update({ where: { id: req.params.id }, data: { status: 'accepted' } })
  return { ok: true }
})

app.put('/api/messages/:id/reject', { preHandler: auth }, async (req) => {
  await prisma.message.update({ where: { id: req.params.id }, data: { status: 'rejected' } })
  return { ok: true }
})

// ============================================================
// 健康检查
// ============================================================
app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }))


// 环境诊断（上线前移除）
app.get("/api/diag", async () => ({
  wx_appid_set: !!(process.env.WX_APPID),
  wx_appid_len: (process.env.WX_APPID || "").length,
  wx_secret_set: !!(process.env.WX_SECRET),
  wx_secret_len: (process.env.WX_SECRET || "").length,
  jwt_set: !!(process.env.JWT_SECRET),
  jwt_len: (process.env.JWT_SECRET || "").length,
  node_env: process.env.NODE_ENV || "not set"
}));
// 启动
const PORT = process.env.PORT || 3456
await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`心汐 API → http://localhost:${PORT}`)
