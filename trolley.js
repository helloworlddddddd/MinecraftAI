const mineflayer = require('mineflayer')
const { Ollama } = require('ollama')

const ollama = new Ollama()

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 1025,
  username: 'AIBot',
  version: '1.21.1',
})

bot.once('spawn', () => {
  console.log('ボット接続完了。待機中...')
  bot.chat('接続しました。「!トロッコ」と入力するとトロッコ問題を考えます。')
})

// チャットで指示を受け取る
bot.on('chat', async (username, message) => {
  if (username === bot.username) return  // 自分の発言は無視

  if (message === '!トロッコ') {
    await runTrolleyProblem()
  }

  if (message === '!どこ') {
    const pos = bot.entity.position
    bot.chat(`現在地：X=${Math.floor(pos.x)} Y=${Math.floor(pos.y)} Z=${Math.floor(pos.z)}`)
  }

  if (message === '!来い') {
    const player = bot.players[username]
    if (player && player.entity) {
      const pos = player.entity.position
      bot.chat(`${username}さんのところへ向かいます`)
      bot.pathfinder?.goto(pos)
    }
  }
})

async function runTrolleyProblem() {
  const situation = `
あなたはMinecraftの世界にいます。
トロッコが走っており、このまま進むと5人の村人が死にます。
レバーを引けば別の線路に切り替わりますが、その先には1人の村人がいます。
レバーを引きますか？引きませんか？
日本語で理由を述べ、最後に「決断：レバーを引く」か「決断：レバーを引かない」と明記してください。
`

  bot.chat('トロッコ問題を考えています...')

  const response = await ollama.chat({
    model: 'qwen2.5:14b',
    messages: [{ role: 'user', content: situation }]
  })

  const answer = response.message.content
  console.log('AIの回答:\n', answer)

  const chunks = splitMessage(answer, 200)
  for (const chunk of chunks) {
    bot.chat(chunk)
    await sleep(2000)
  }

  if (answer.includes('レバーを引く') && !answer.includes('引かない')) {
    bot.chat('【行動：レバーを引きます】')
  } else {
    bot.chat('【行動：レバーを引きません】')
  }
}

function splitMessage(text, maxLen) {
  const chunks = []
  while (text.length > 0) {
    chunks.push(text.substring(0, maxLen))
    text = text.substring(maxLen)
  }
  return chunks
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

bot.on('error', err => console.error('エラー:', err))
bot.on('kicked', reason => console.log('キック:', reason))
