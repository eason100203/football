require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();

// LINE 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 中間件 - LINE middleware 要先執行（用於驗證簽名）
app.use('/webhook', line.middleware(config));

// 其他中間件
app.use(express.json());

app.post('/webhook', async (req, res) => {
  Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const text = event.message.text;
  const userId = event.source.userId;

  // 建立使用者
  await supabase.from('users').upsert({
    id: userId,
    name: '玩家'
  });

  // 👉 下注
  if (text.startsWith('下注')) {
    const [_, team, amount] = text.split(' ');

    await supabase.from('bets').insert({
      user_id: userId,
      team,
      amount: parseInt(amount)
    });

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已下注 ${team} ${amount}`
    });
  }

  // 👉 我的下注
  if (text === '我的下注') {
    const { data } = await supabase
      .from('bets')
      .select('*')
      .eq('user_id', userId);

    const msg = data.map(b => `${b.team} ${b.amount}`).join('\n') || '無';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: msg
    });
  }

  // 👉 圓餅圖
  if (text === '比例') {
    const { data } = await supabase.from('bets').select('*');

    const result = {};
    data.forEach(b => {
      result[b.team] = (result[b.team] || 0) + b.amount;
    });

    const labels = Object.keys(result);
    const values = Object.values(result);

    const chartUrl = `https://quickchart.io/chart?c={
      type:'pie',
      data:{labels:${JSON.stringify(labels)},datasets:[{data:${JSON.stringify(values)}}]}
    }`;

    return client.replyMessage(event.replyToken, {
      type: 'image',
      originalContentUrl: chartUrl,
      previewImageUrl: chartUrl
    });
  }

  // 👉 結算
  if (text.startsWith('結算')) {
    const winTeam = text.split(' ')[1];

    const { data } = await supabase.from('bets').select('*');

    for (const bet of data) {
      if (bet.team === winTeam) {
        await supabase.rpc('increment_balance', {
          uid: bet.user_id,
          amount: bet.amount
        });
      } else {
        await supabase.rpc('increment_balance', {
          uid: bet.user_id,
          amount: -bet.amount
        });
      }
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🏆 ${winTeam} 勝！已結算`
    });
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '⚽ 足球投注 BOT\n\n📋 可用指令：\n• 下注 隊伍 金額\n• 我的下注\n• 比例\n• 結算 隊伍\n\n💡 範例：下注 曼聯 100'
  });
}

app.listen(8686, () => console.log('running'));