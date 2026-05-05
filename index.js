require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const dayjs = require('dayjs'); 
const app = express();
const { getTeamNameZh } = require('./teamName.js');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// football-data.org API 配置
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_DATA_BASE_URL = 'https://api.football-data.org/v4';

app.use('/webhook', line.middleware(config));
app.use(express.json());

app.post('/webhook', async (req, res) => {
  Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// ────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;
  if (!userId) return;

  if (event.type === 'follow') {
    await ensureUser(userId);
    const user = await getUser(userId);

    if (!user.nickname) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '👋 歡迎加入！\n請先設定你的暱稱：\n\n設定暱稱 你的暱稱'
      });
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚽ 歡迎回歸戰場！'
    });
  }

  if (event.type !== 'message') return;

  const text = event.message.text?.trim();
  if (!text) return;

  await ensureUser(userId);
  const user = await getUser(userId);

  // 新用戶還沒設定暱稱，強制引導
  if (!user.nickname && !text.startsWith('設定暱稱')) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請先設定暱稱才能使用：\n\n設定暱稱 你的暱稱'
    });
  }

  // ── 設定暱稱
  if (text.startsWith('設定暱稱')) {
    const nickname = text.replace('設定暱稱', '').trim();
    if (!nickname) {
      return client.replyMessage(event.replyToken, {
        type: 'text', text: '請輸入暱稱，例如：設定暱稱 禿頭'
      });
    }
   const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('nickname', nickname)
    .single();

  if (existing && existing.id !== userId) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: `❌ 暱稱「${nickname}」已被使用，請換一個`
    });
  }
    await supabase.from('users').update({ nickname }).eq('id', userId);
    return client.replyMessage(event.replyToken, {
      type: 'text', text: `✅ 暱稱已設定為：${nickname}`
    });
  }

  // ── 下注 #3 阿根廷 2-50 500
  if (text.startsWith('下注')) {
    const parts = text.split(' ');
    // parts: ['下注', '#3', '阿根廷', '2-50', '500']
    if (parts.length !== 5) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '格式錯誤\n正確格式：下注 #場次 隊伍 條件 金額\n範例：下注 #3 阿根廷 2-50 500'
      });
    }

    const seqNo = parseInt(parts[1].replace('#', ''));
    const team = parts[2];
    const condition = parts[3];
    const amount = parseInt(parts[4]);

    if (isNaN(seqNo) || isNaN(amount)) {
      return client.replyMessage(event.replyToken, {
        type: 'text', text: '場次或金額格式錯誤'
      });
    }

    // 確認場次存在且開放（使用 SeqNo 映射內部 match id）
    const { data: match } = await supabase
      .from('matches')
      .select('*')
      .eq('seq_no', seqNo)
      .single();

    if (!match) {
      return client.replyMessage(event.replyToken, {
        type: 'text', text: `找不到場次 #${matchId}`
      });
    }
    if (match.status !== 'open') {
      return client.replyMessage(event.replyToken, {
        type: 'text', text: `場次 #${matchId} 已關閉，無法下注`
      });
    }

    await supabase.from('bets').insert({
      match_id: matchId,
      user_id: userId,
      team,
      condition,
      amount
    });

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 下注成功\n📋 ${match.label}\n👤 ${user.nickname}\n⚽ ${team} ${condition}\n💰 ${amount}`
    });
  }

  // ── 我的下注
  if (text === '我的下注紀錄') {
    const { data: bets } = await supabase
      .from('bets')
      .select('*, matches(label)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!bets?.length) {
      return client.replyMessage(event.replyToken, {
        type: 'text', text: '你還沒有任何下注紀錄'
      });
    }

    const msg = bets.map(b =>
      `#${b.match_id} ${b.matches.label}\n  ${b.team} ${b.condition} $${b.amount}`
    ).join('\n\n');

    return client.replyMessage(event.replyToken, {
      type: 'text', text: `🎯 ${user.nickname} 的下注紀錄\n\n${msg}`
    });
  }

  // ── 賽事列表
  if (text === '賽事列表') {
    try {
      const matches = await getWeeklyMatches();

      if (!matches || matches.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text', text: '本週沒有世足賽事'
        });
      }

      const msg = matches.map(m =>
        `#${m.seq_no} ${m.match_date} ${getTeamNameZh(m.home_team_name)|| 'TBD'} vs ${getTeamNameZh(m.away_team_name)|| 'TBD'}`
      ).join('\n');

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `⚽ 本週世足賽事\n\n${msg}`
      });
    } catch (error) {
      console.error('Error fetching matches:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text', text: '❌ 無法獲取賽事資訊，請稍後再試'
      });
    }
  }

  // ── 查看場次 #3
  if (text.startsWith('查看場次')) {
    const seqNo = parseInt(text.replace('查看場次 #', ''));

    const { data: match } = await supabase
      .from('matches')
      .select('*')
      .eq('seq_no', seqNo)
      .single();

    const { data: bets } = await supabase
      .from('bets')
      .select('*, users(nickname)')
      .eq('match_id', matchId)
      .order('created_at', { ascending: true });

    const { data: results } = await supabase
      .from('results')
      .select('*, users(nickname)')
      .eq('match_id', matchId);

    if (!bets?.length) {
      return client.replyMessage(event.replyToken, {
        type: 'text', text: `#${matchId} ${match?.label}\n\n尚無下注紀錄`
      });
    }

    // 下注紀錄
    const betMsg = bets.map(b =>
      `${b.users.nickname}：${b.team} ${b.condition} $${b.amount}`
    ).join('\n');

    // 統計結果
    let resultMsg = '';
    if (results?.length) {
      resultMsg = '\n\n📊 統計結果：\n' + results.map(r =>
        `${r.users.nickname}：${r.description} ${r.amount > 0 ? '+' : ''}${r.amount}`
      ).join('\n');
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `⚽ #${matchId} ${match.label}\n\n🎯 下注紀錄：\n${betMsg}${resultMsg}`
    });
  }

  // ════════════════════════════════
  // 以下為管理員指令
  // ════════════════════════════════

  if (!user.is_admin) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚽ 可用指令：\n\n• 賽事列表\n• 下注 #場次 隊伍 條件 金額\n• 我的下注紀錄\n\n範例：下注 #1 阿根廷 全場勝 500'
    });
  }

  // ────────────────────────────────────────
  // 預設回覆
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '⚽ 可用指令：\n\n• 賽事列表\n• 下注 #場次 隊伍 條件 金額\n• 我的下注紀錄\n\n範例：下注 #1 阿根廷 全場勝 500'
  });
}

// ────────────────────────────────────────
async function getWeeklyMatches() {
  const now = dayjs();
  const startOfToday = now.startOf('day').format('YYYY-MM-DD HH:mm');
  const endOfWeek = now.add(7, 'day').endOf('day').format('YYYY-MM-DD HH:mm');

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .gte('match_date', startOfToday)
    .lte('match_date', endOfWeek)
    .order('match_date', { ascending: true });

  if (error) throw error;
  return data || [];
}

// ────────────────────────────────────────
async function getUser(userId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
  return data;
}

async function ensureUser(userId) {
  let name = '匿名用戶';
  try {
    const profile = await client.getProfile(userId);
    if (profile?.displayName) name = profile.displayName;
  } catch (e) {
    console.error('getProfile 失敗：', e.message);
  }

  await supabase.from('users').upsert({ id: userId, name }, { ignoreDuplicates: true });
}

async function setupRichMenu() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  
  if (!token) {
    console.error('❌ 環境變數 LINE_CHANNEL_ACCESS_TOKEN 未設定');
    return;
  }

  try {
    const headers = { Authorization: `Bearer ${token}` };

    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: '主選單',
      chatBarText: '哇嘎哇嘎⚽功能選單',
      areas: [
        { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'message', text: '賽事列表' } },
        { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: { type: 'message', text: '賽前分析' } },
        { bounds: { x: 1666, y: 0,   width: 834, height: 843 }, action: { type: 'message', text: '小組排行' } },
        { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: { type: 'message', text: '我的下注紀錄' } },
        { bounds: { x: 833,  y: 843, width: 833, height: 843 }, action: { type: 'message', text: '賽事下注紀錄' } },
        { bounds: { x: 1666, y: 843, width: 834, height: 843 }, action: { type: 'message', text: '輸贏統計' } },
      ]
    };

    // 建立 Rich Menu
    const createRes = await axios.post(
      'https://api.line.me/v2/bot/richmenu',
      richMenu,
      { headers }
    );
    const richMenuId = createRes.data.richMenuId;
    console.log('✅ Rich Menu 建立完成:', richMenuId);

    // 上傳圖片（需要 2500x1686 的 PNG 圖片）
    if (fs.existsSync('./menu1.png')) {
      const imageBuffer = fs.readFileSync('./menu1.png');

      await axios.post(
        `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
        imageBuffer,
        { headers: { ...headers, 'Content-Type': 'image/png' } }
      );
      console.log('✅ Rich Menu 圖片上傳完成');
    } else {
      console.warn('⚠️ menu.png 不存在，無法完成設定。請準備 2500x1686 的 PNG 圖片');
      return;
    }

    // 設為預設
    await axios.post(
      `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
      {},
      { headers }
    );
    console.log('✅ Rich Menu 已設為預設');

  } catch (error) {
    console.error('❌ Rich Menu 設定失敗：', error.response?.data || error.message);
  }
}

setupRichMenu().catch(console.error);
app.listen(8686, () => console.log('running'));