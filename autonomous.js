const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Ollama } = require('ollama')

const ollama = new Ollama()

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 1025,
  username: 'AIBot',
  version: '1.21.1',
})
bot.loadPlugin(pathfinder)

// ========== 状態管理 ==========
const STATE = { IDLE: 'IDLE', EXPLORE: 'EXPLORE', FIGHT: 'FIGHT', FLEE: 'FLEE', FOLLOW: 'FOLLOW', GATHER: 'GATHER' }
let state        = STATE.IDLE
let target       = null
let gatherTask   = null  // { blockName, maxCount }
let lastHealth   = 20
let lastChatTime = 0
let idleCounter  = 0
let mcData       = null

const FIGHT_RANGE  = 8
const ATTACK_RANGE = 3.5

// ブロック名マッピング（日本語 → Minecraft ID）
const BLOCK_MAP = {
  '木': ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log'],
  '原木': ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log'],
  '石': ['stone','cobblestone'],
  '砂': ['sand'],
  '土': ['dirt','grass_block'],
  '石炭': ['coal_ore','deepslate_coal_ore'],
  '鉄': ['iron_ore','deepslate_iron_ore'],
}

// ========== 起動 ==========
bot.once('spawn', () => {
  lastHealth = bot.health
  mcData = require('minecraft-data')(bot.version)
  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)
  console.log('起動')
  bot.chat('起動しました。')
  setInterval(behaviorTick, 100)
  setInterval(cognitiveTick, 30000)
  setInterval(idleCheck, 5000)
})

// ========== 反射層 ==========

bot.on('health', () => {
  if (bot.health < lastHealth) {
    console.log(`体力減少: ${lastHealth} → ${bot.health}`)
    if (bot.health <= 4) {
      setState(STATE.FLEE)
    } else if (state !== STATE.FIGHT) {
      const nearest = getNearestPlayer()
      if (nearest) { target = nearest; setState(STATE.FIGHT) }
    }
  }
  if (state === STATE.FLEE && bot.health > 10) setState(STATE.IDLE)
  lastHealth = bot.health
})

// ========== 行動層（100ms） ==========

function behaviorTick() {
  if (state === STATE.FOLLOW) { followTick(); return }
  if (state === STATE.GATHER) return  // GATHERは非同期で別管理

  if (state === STATE.IDLE || state === STATE.EXPLORE) {
    const nearest = getNearestPlayer()
    if (nearest?.entity) {
      const dist = bot.entity.position.distanceTo(nearest.entity.position)
      if (dist < FIGHT_RANGE) { target = nearest; setState(STATE.FIGHT); return }
    }
  }

  switch (state) {
    case STATE.IDLE:    bot.clearControlStates(); break
    case STATE.FIGHT:   fightTick(); break
    case STATE.FLEE:    fleeTick(); break
    case STATE.EXPLORE: break
  }
}

function fightTick() {
  const nearest = getNearestPlayer()
  if (!nearest?.entity) { setState(STATE.IDLE); return }
  target = nearest
  const dist = bot.entity.position.distanceTo(target.entity.position)
  bot.lookAt(target.entity.position.offset(0, 1.6, 0))
  if (dist < ATTACK_RANGE) {
    bot.clearControlStates()
    bot.attack(target.entity)
  } else {
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
  }
  if (dist > 20) setState(STATE.IDLE)
}

function followTick() {
  const nearest = getNearestPlayer()
  if (!nearest?.entity) { setState(STATE.IDLE); return }
  const dist = bot.entity.position.distanceTo(nearest.entity.position)
  bot.lookAt(nearest.entity.position.offset(0, 1.6, 0))
  if (dist > 3) {
    bot.setControlState('forward', true)
    bot.setControlState('sprint', dist > 8)
  } else {
    bot.clearControlStates()
  }
}

function fleeTick() {
  const nearest = getNearestPlayer()
  if (!nearest?.entity) { bot.clearControlStates(); return }
  const away = bot.entity.position.minus(nearest.entity.position)
  bot.entity.yaw = Math.atan2(-away.x, -away.z)
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
}

// ========== 採掘タスク ==========

async function runGatherTask(blockNames, maxCount) {
  setState(STATE.GATHER)
  bot.chat(`${blockNames[0]}を集めます。`)
  let collected = 0

  while (state === STATE.GATHER && collected < maxCount) {
    // 最寄りのブロックを探す
    const blockIds = blockNames
      .map(n => mcData.blocksByName[n]?.id)
      .filter(Boolean)

    const block = bot.findBlock({
      matching: blockIds,
      maxDistance: 64,
    })

    if (!block) {
      bot.chat('近くに見つかりませんでした。')
      break
    }

    try {
      await bot.pathfinder.goto(new goals.GoalBlock(block.position.x, block.position.y, block.position.z))
      await bot.dig(block)
      collected++
      console.log(`採掘: ${block.name} (${collected}/${maxCount})`)
    } catch (e) {
      console.error('採掘エラー:', e.message)
      break
    }
  }

  bot.chat(`完了しました。（${collected}個）`)
  setState(STATE.IDLE)
}

// ========== アイドル→探索 ==========

function idleCheck() {
  if (state !== STATE.IDLE) { idleCounter = 0; return }
  idleCounter++
  if (idleCounter >= 4) {
    idleCounter = 0
    setState(STATE.EXPLORE)
    bot.entity.yaw = Math.random() * Math.PI * 2
    bot.setControlState('forward', true)
    setTimeout(() => {
      if (state === STATE.EXPLORE) {
        bot.setControlState('forward', false)
        setState(STATE.IDLE)
      }
    }, 3000 + Math.random() * 3000)
  }
}

// ========== 認知層（LLM・30秒） ==========

async function cognitiveTick() {
  if (state === STATE.FIGHT || state === STATE.FLEE || state === STATE.GATHER) return
  if (Date.now() - lastChatTime < 30000) return
  try {
    const res = await ollama.chat({
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: `MinecraftのAI。状況を見て一言だけ日本語で自然に発言せよ。短く。\n${buildContext()}` }],
    })
    const msg = res.message.content.trim().substring(0, 100)
    if (msg) { bot.chat(msg); lastChatTime = Date.now() }
  } catch (e) {
    console.error('LLMエラー:', e.message)
  }
}

// ========== チャット受信・LLM解釈 ==========

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  interpretAndAct(username, message)
})

async function interpretAndAct(username, message) {
  try {
    const blockList = Object.keys(BLOCK_MAP).join('・')
    const res = await ollama.chat({
      model: 'qwen2.5:7b',
      messages: [{
        role: 'user',
        content: `MinecraftのAIボット。プレイヤーの発言の意図を読み取りJSONで1行だけ答えよ。

発言者: ${username}  発言:「${message}」  現在の状態: ${state}

選択肢:
{"intent":"FIGHT"} // 戦え・攻撃・かかってこい
{"intent":"FOLLOW"} // ついてこい・ついてくる
{"intent":"FLEE"} // 逃げろ・下がれ・離れろ
{"intent":"IDLE"} // 止まれ・やめろ・休め
{"intent":"GATHER","block":"木","count":10} // ～を集めろ・採掘・取ってこい（block=${blockList}、countは個数。指定なければ10）
{"intent":"CHAT","message":"返答"} // 質問・雑談・その他

JSONのみ出力:`
      }],
    })

    const text = res.message.content.trim()
    const match = text.match(/\{[\s\S]*?\}/)
    if (!match) return
    const parsed = JSON.parse(match[0])
    console.log(`解釈 [${username}: ${message}] →`, parsed)

    switch (parsed.intent) {
      case 'FIGHT':
        target = getNearestPlayer(); setState(STATE.FIGHT); break
      case 'FOLLOW':
        setState(STATE.FOLLOW); break
      case 'FLEE':
        setState(STATE.FLEE); break
      case 'IDLE':
        setState(STATE.IDLE); bot.chat('わかった。'); break
      case 'GATHER': {
        const blockNames = BLOCK_MAP[parsed.block] ?? BLOCK_MAP['木']
        const count = parseInt(parsed.count) || 10
        runGatherTask(blockNames, count)
        break
      }
      case 'CHAT':
        if (parsed.message) { bot.chat(parsed.message); lastChatTime = Date.now() }
        break
    }
  } catch (e) {
    console.error('解釈エラー:', e.message)
  }
}

// ========== ユーティリティ ==========

function setState(newState) {
  if (state === newState) return
  console.log(`状態: ${state} → ${newState}`)
  state = newState
  if (newState !== STATE.FIGHT && newState !== STATE.FLEE) bot.clearControlStates()
}

function getNearestPlayer() {
  return Object.values(bot.players)
    .filter(p => p.entity && p.username !== bot.username)
    .sort((a, b) =>
      bot.entity.position.distanceTo(a.entity.position) -
      bot.entity.position.distanceTo(b.entity.position)
    )[0] ?? null
}

function buildContext() {
  const pos = bot.entity.position
  const players = Object.values(bot.players)
    .filter(p => p.entity && p.username !== bot.username)
    .map(p => `${p.username}(${Math.floor(bot.entity.position.distanceTo(p.entity.position))}m)`)
  return `状態:${state} 体力:${Math.floor(bot.health)}/20 位置:${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} プレイヤー:${players.join(',') || 'なし'}`
}

bot.on('error',  err    => console.error('エラー:', err))
bot.on('kicked', reason => console.log('キック:', reason))
