import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

// 云托管会注入 MYSQL_URL，自动切换 MySQL
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

  let openid = code
  const hasCredentials = WX_APPID && WX_SECRET
  if (hasCredentials && code) {
    try {
      const r = await fetch(
        `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`
      )
      const data = await r.json()
      if (data.openid) openid = data.openid
      else return reply.code(400).send({ error: '登录失败', detail: data })
    } catch (e) {
      return reply.code(502).send({ error: "微信服务暂不可用" })
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
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return reply.code(401).send({ error: '未登录' })
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET)
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
// 湖面状态
// ============================================================
app.get('/api/lake-state', { preHandler: auth }, async (req) => {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const moods = await prisma.mood.findMany({
    where: { userId: req.userId, createdAt: { gte: today } },
    orderBy: { createdAt: 'desc' }
  })
  const count = moods.length
  const state = count >= 5 ? 'ripples' : count >= 3 ? 'breeze' : 'mirror'

  const hasNegative = moods.some(m => m.mood === '低落' || m.mood === '焦虑')
  const insight = count === 0
    ? '今天还没有投下石子，湖面如镜，波澜不惊。'
    : hasNegative
    ? '湖面有些波澜——今天的心情不是风平浪静，但涟漪终会散去。'
    : '今日湖面映照着你的心情，微风拂过，泛起浅浅涟漪。'

  return { state, moods, insight }
})

// ============================================================
// 羁绊
// ============================================================
app.get('/api/bonds', { preHandler: auth }, async (req) => {
  const bonds = await prisma.bond.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'asc' }
  })
  return bonds
})

// 通过分享建立羁绊
app.post('/api/bonds/share', { preHandler: auth }, async (req) => {
  const { fromUserId } = req.body
  if (!fromUserId) return reply.code(400).send({ error: '缺少分享来源' })
  if (fromUserId === req.userId) return { alreadyLinked: true }

  // 查来源用户
  const fromUser = await prisma.user.findUnique({ where: { id: fromUserId } })
  if (!fromUser) return reply.code(404).send({ error: '来源用户不存在' })

  // 查当前用户
  const me = await prisma.user.findUnique({ where: { id: req.userId } })

  // 查是否已有羁绊
  const existing = await prisma.bond.findFirst({
    where: { userId: req.userId, bondUserId: fromUserId }
  })
  if (existing) return { alreadyLinked: true, bond: existing }

  // 双向创建羁绊
  const bondA = await prisma.bond.create({
    data: {
      userId: req.userId,
      bondUserId: fromUserId,
      name: fromUser.nickname || '守望者',
      relation: '朋友',
      type: '守护光点'
    }
  })
  const bondB = await prisma.bond.create({
    data: {
      userId: fromUserId,
      bondUserId: req.userId,
      name: me.nickname || '守望者',
      relation: '朋友',
      type: '守护光点'
    }
  })

  return { linked: true, bond: bondA }
})

// 手动创建羁绊（保留，用于添加非分享来源的联系）
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
app.get("/api/diag", async () => ({
  wx_appid_set: !!(process.env.WX_APPID),
  wx_appid_len: (process.env.WX_APPID || "").length,
  wx_secret_set: !!(process.env.WX_SECRET),
  wx_secret_len: (process.env.WX_SECRET || "").length,
  jwt_set: !!(process.env.JWT_SECRET),
  node_env: process.env.NODE_ENV || "not set"
}))

const PORT = process.env.PORT || 3456
await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`心汐 API → http://localhost:${PORT}`)
