const mineflayer = require('mineflayer')
const { Ollama } = require('ollama')

const ollama = new Ollama()

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 1025,
  username: 'AIBot',
  version: '1.21.1',
})

const THINK_INTERVAL = 15000   // 15秒ごとに思考
const CHAT_COOLDOWN  = 30000   // 発言は30秒に1回まで

let isThinking    = false
let autonomous    = true
let lastChatTime  = 0
let recentChat    = []         // ループ後にクリアする使い捨てバッファ
let lastActions   = []         // 直近の自分の行動履歴（繰り返し防止）

bot.once('spawn', () => {
  console.log('自律ボット起動')
  bot.chat('起動しました。')
  setInterval(autonomousLoop, THINK_INTERVAL)
})

// ========== 知覚 ==========

function buildContext() {
  const pos = bot.entity.position

  const nearbyPlayers = Object.values(bot.players)
    .filter(p => p.entity && p.username !== bot.username)
    .map(p => {
      const dist = Math.floor(bot.entity.position.distanceTo(p.entity.position))
      return `${p.username}（${dist}m）`
    })

  const nearbyMobs = Object.values(bot.entities)
    .filter(e => e !== bot.entity && bot.entity.position.distanceTo(e.position) < 16)
    .slice(0, 6)
    .map(e => `${e.name || e.type}（${Math.floor(bot.entity.position.distanceTo(e.position))}m）`)

  const chatLog = recentChat.length > 0
    ? recentChat.map(c => `  ${c.username}: ${c.message}`).join('\n')
    : '  なし'

  const actionLog = lastActions.length > 0
    ? lastActions.join(' → ')
    : 'なし'

  return `
【状況】
位置: X=${Math.floor(pos.x)} Y=${Math.floor(pos.y)} Z=${Math.floor(pos.z)}
体力: ${Math.floor(bot.health)}/20  満腹度: ${Math.floor(bot.food)}/20
近くのプレイヤー: ${nearbyPlayers.length > 0 ? nearbyPlayers.join(', ') : 'なし'}
近くのモブ: ${nearbyMobs.length > 0 ? nearbyMobs.join(', ') : 'なし'}
直近のチャット:
${chatLog}
自分の直近の行動: ${actionLog}
`.trim()
}

// ========== 思考 ==========

async function think(context, extra = '') {
  const canChat = (Date.now() - lastChatTime) >= CHAT_COOLDOWN

  const prompt = `MinecraftのAI。次の行動をJSON1行で出力せよ。繰り返し禁止。CHAT=${canChat ? 'OK' : 'NG'}。

${context}${extra ? `\n追加: ${extra}` : ''}

{"action":"CHAT","message":"..."} or {"action":"MOVE","reason":"..."} or {"action":"IDLE","thought":"..."}`

  const response = await ollama.chat({
    model: 'qwen2.5:7b',
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.message.content.trim()
  console.log('AI思考:', text)

  try {
    const match = text.match(/\{[\s\S]*?\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      // クールダウン中にCHATを選んでしまった場合はIDLEに差し替え
      if (parsed.action === 'CHAT' && !canChat) {
        return { action: 'IDLE', thought: 'クールダウン中のため待機' }
      }
      return parsed
    }
  } catch (e) {
    console.error('JSON解析失敗:', text)
  }

  return { action: 'IDLE', thought: '判断不能' }
}

// ========== 行動 ==========

async function executeAction(action) {
  console.log('行動:', JSON.stringify(action))

  switch (action.action) {
    case 'CHAT':
      if (action.message) {
        bot.chat(action.message)
        lastChatTime = Date.now()
        addActionLog(`CHAT: ${action.message.substring(0, 20)}`)
      }
      break

    case 'MOVE':
      bot.entity.yaw = Math.random() * Math.PI * 2
      bot.setControlState('forward', true)
      await sleep(1500 + Math.random() * 2000)
      bot.setControlState('forward', false)
      addActionLog('MOVE')
      break

    case 'IDLE':
      if (action.thought) console.log('待機:', action.thought)
      addActionLog('IDLE')
      break
  }
}

function addActionLog(label) {
  lastActions.push(label)
  if (lastActions.length > 4) lastActions.shift()
}

// ========== 自律ループ ==========

async function autonomousLoop() {
  if (!autonomous || isThinking) return
  isThinking = true
  try {
    const context = buildContext()
    const action = await think(context)
    await executeAction(action)
  } catch (e) {
    console.error('ループエラー:', e.message)
  } finally {
    recentChat = []   // 処理済みチャットをクリア
    isThinking = false
  }
}

// ========== イベント対応 ==========

bot.on('entityHurt', (entity) => {
  if (entity !== bot.entity || isThinking) return
  isThinking = true
  const context = buildContext()
  think(context, '攻撃を受けた！').then(executeAction).catch(console.error).finally(() => {
    recentChat = []
    isThinking = false
  })
})

bot.on('health', () => {
  if (bot.health < 6 && !isThinking) {
    isThinking = true
    const context = buildContext()
    think(context, `体力が危険（${Math.floor(bot.health)}/20）`).then(executeAction).catch(console.error).finally(() => {
      recentChat = []
      isThinking = false
    })
  }
})

let lastGreeted = {}
bot.on('entitySpawn', (entity) => {
  if (entity.type !== 'player') return
  const username = entity.username
  if (!username || username === bot.username) return
  const now = Date.now()
  if (lastGreeted[username] && now - lastGreeted[username] < 60000) return
  lastGreeted[username] = now
  if (isThinking) return
  isThinking = true
  const context = buildContext()
  think(context, `${username} が近くに現れた`).then(executeAction).catch(console.error).finally(() => {
    recentChat = []
    isThinking = false
  })
})

// ========== チャット受信 ==========

bot.on('chat', (username, message) => {
  if (username === bot.username) return

  if (message === '!停止') { autonomous = false; bot.chat('停止します。'); return }
  if (message === '!再開') { autonomous = true;  bot.chat('再開します。'); return }
  if (message === '!どこ') {
    const p = bot.entity.position
    bot.chat(`X=${Math.floor(p.x)} Y=${Math.floor(p.y)} Z=${Math.floor(p.z)}`)
    return
  }

  // 通常発言はバッファに積むだけ（ループで消費）
  recentChat.push({ username, message })
  if (recentChat.length > 5) recentChat.shift()
})

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

bot.on('error', err => console.error('エラー:', err))
bot.on('kicked', reason => console.log('キック:', reason))
