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
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// football-data.org API 配置
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_DATA_BASE_URL = 'https://api.football-data.org/v4';
const TUTORIAL_IMAGE_URL =process.env.TUTORIAL_IMAGE_URL

app.get('/', (req, res) => {
  console.log('Ping:', new Date().toISOString());
  res.send('alive');
});

app.use('/webhook', line.middleware(config));
app.use(express.json());

app.post('/webhook', async (req, res) => {
  Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

let chatHistory = {}; 
let userState = {}; // 記錄用戶狀態
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
  try {
    await client.replyMessage(event.replyToken, [
       {
        type: 'text',
        text: '請先設定暱稱才能使用：\n\n設定暱稱 你的暱稱'
      },
      {
        type: 'image',
        originalContentUrl: TUTORIAL_IMAGE_URL,
        previewImageUrl: TUTORIAL_IMAGE_URL
      }
    ]);
  } catch (err) {
    console.error('replyMessage 錯誤:', err.response?.data || err.message);
  }
  return;
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

  // ── 賽事列表
  if (text === '賽事列表') {
    userState[userId] = 'waiting_for_category';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚽ 請選擇賽事分類：\n\n1️⃣ 今日世足賽事\n2️⃣ 一週內世足賽事\n3️⃣ 全部世足賽事\n\n請輸入 1、2 或 3'
    });
  }

  // ── 處理賽事列表分類選擇
  if (userState[userId] === 'waiting_for_category' && ['1', '2', '3'].includes(text)) {
    delete userState[userId];
    
    try {
      let matches = [];
      let title = '';

      if (text === '1') {
        matches = await getTodayMatches();
        title = '今日賽事';
      } else if (text === '2') {
        matches = await getWeeklyMatches();
        title = '一週賽事';
      } else if (text === '3') {
        matches = await getAllMatches();
        title = '全部賽事';
      }

      if (!matches || matches.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text', text: `⚽ ${title}\n\n目前沒有賽事`
        });
      }

      const msg = matches.map(m =>
        `#${m.seq_no} ${m.match_date} ${getTeamNameZh(m.home_team_name)|| 'TBD'} vs ${getTeamNameZh(m.away_team_name)|| 'TBD'}`
      ).join('\n');

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `⚽ ${title}\n\n${msg}`
      });
    } catch (error) {
      console.error('Error fetching matches:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text', text: '❌ 無法獲取賽事資訊，請稍後再試'
      });
    }
  }

  // ── 小組排行
  if (text === '小組排行') {
    delete userState[userId];
    try {
      const standings = await getStandings();
      if (!standings || standings.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '⚽ 小組排行\n\n目前還沒有 standings 資料'
        });
      }

      const groups = {};
      standings.forEach(row => {
        const group = row.group_name || 'Group';
        if (!groups[group]) groups[group] = [];
        groups[group].push(row);
      });

     const bubbles = Object.entries(groups).map(([group, rows]) => {

  const headerRow = {
    type: 'box',
    layout: 'baseline',
    backgroundColor: '#111827',
    paddingAll: '6px',
    contents: [
      { type: 'text', text: '#', size: 'xs', color: '#9ca3af', flex: 1 },
      { type: 'text', text: '隊伍', size: 'xs', color: '#9ca3af', flex: 6 },
      { type: 'text', text: '贏', size: 'xs', color: '#9ca3af', flex: 1, align: 'center' },
      { type: 'text', text: '和', size: 'xs', color: '#9ca3af', flex: 1, align: 'center' },
      { type: 'text', text: '負', size: 'xs', color: '#9ca3af', flex: 1, align: 'center' },
      { type: 'text', text: '積分', size: 'xs', color: '#fbbf24', flex: 2, align: 'end', weight: 'bold' }
    ]
  };

  const rowItems = rows.map((r, idx) => {
    const teamName = r.team_name || r.team_short_name || 'TBD';

    return {
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      margin: 'sm',
      paddingAll: '4px',
      backgroundColor: idx % 2 === 0 ? '#0b1220' : '#0f172a',
      contents: [
        { type: 'text', text: String(r.position), size: 'xs', color: '#94a3b8', flex: 1 },

        {
          type: 'text',
          text: getTeamNameZh(teamName),
          size: 'sm',
          color: '#ffffff',
          flex: 6,
          wrap: true,
          weight: 'bold'
        },

        { type: 'text', text: String(r.won ?? 0), size: 'xs', color: '#22c55e', flex: 1, align: 'center' },
        { type: 'text', text: String(r.draw ?? 0), size: 'xs', color: '#facc15', flex: 1, align: 'center' },
        { type: 'text', text: String(r.lost ?? 0), size: 'xs', color: '#ef4444', flex: 1, align: 'center' },

        {
          type: 'text',
          text: String(r.points ?? 0),
          size: 'sm',
          color: '#fbbf24',
          flex: 2,
          align: 'end',
          weight: 'bold'
        }
      ]
    };
  });

  return {
    type: 'bubble',

    styles: {
      body: {
        backgroundColor: '#0b1220'
      }
    },

    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0f172a',
      paddingAll: '12px',
      contents: [
        {
          type: 'text',
          text: `${group}`,
          weight: 'bold',
          size: 'xl',
          color: '#ffffff'
        },
        {
          type: 'text',
          text: 'FIFA World Cup Standings',
          size: 'xs',
          color: '#94a3b8'
        }
      ]
    },

    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        headerRow,
        {
          type: 'separator',
          margin: 'md',
          color: '#1f2937'
        },
        ...rowItems
      ]
    }
  };
});

      return client.replyMessage(event.replyToken, {
        type: 'flex',
        altText: '小組排行',
        contents: {
          type: 'carousel',
          contents: bubbles
        }
      });
    } catch (error) {
      console.error('Error fetching standings:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text', text: '❌ 無法取得小組排行，請稍後再試'
      });
    }
  }

  // ── 賽事分析
  if (text === '賽事分析') {
  const { data, error } = await supabase.from('users')
    .update({ mode: 'ai' })
    .eq('id', userId);
  
  console.log('userId:', userId);
  console.log('update error:', error);
  console.log('update data:', data);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '您好，我是AI足球助手糯米⚽\n歡迎提問有關世足的問題，我會幫你分析！\n（輸入「離開」可返回主選單）'
  });
  }

  if (text === '離開') {
  delete chatHistory[userId]; 
  await supabase.from('users')
    .update({ mode: 'normal' })
    .eq('id', userId);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '已離開AI分析模式，糯米滾走了 ⚽'
  });
 }

 if (user.mode === 'ai') {
  // 1. 先判斷使用者是否在找「賽程」或「時間」
  const lowercaseText = text.toLowerCase();
  const isAskingSchedule = lowercaseText.includes('賽程') || 
                           lowercaseText.includes('時間') || 
                           lowercaseText.includes('什麼時候');

  if (isAskingSchedule) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '🤖 進入分析模式時無法查看完整賽程。\n\n請先輸入「離開」退出 AI 模式，並輸入「賽事列表」查詢。取得【比賽編號】後，再回來輸入編號，我能為您做深度分析！'
    });
  }

  try {
    // 2. 篩選「三天內」的賽事資料 (大幅節省 Token)
    const allMatches = await getWeeklyMatches();
   
    // 將資料格式極簡化，只給編號、時間、對戰隊伍
    const matchInfo = allMatches.map(m => 
      `#${m.seq_no} ${m.match_date.slice(5)} ${getTeamNameZh(m.home_team_name)}vs${getTeamNameZh(m.away_team_name)}`
    ).join('\n');

    // 3. 呼叫 AI
    const aiReply = await getMatchAnalysis(userId, text, matchInfo);
    
    return client.replyMessage(event.replyToken, {
      type: 'text', text: aiReply.slice(0, 1000)
    });

  } catch (error) {
    console.error('AI 錯誤:', error.message);
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '❌ AI 助手暫時無法使用，請稍後再試'
    });
  }
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


  // 預設回覆
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '⚽ 可用指令：\n\n• 賽事列表\n• 下注 #場次 隊伍 條件 金額\n• 我的下注紀錄\n\n範例：下注 #1 阿根廷 全場勝 500'
  });
}

// ───────────────────methods────────────────────
async function getTodayMatches() {
  const now = dayjs();
  const startOfToday = now.startOf('day').format('YYYY-MM-DD HH:mm');
  const endOfToday = now.endOf('day').format('YYYY-MM-DD HH:mm');

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .gte('match_date', startOfToday)
    .lte('match_date', endOfToday)
    .order('match_date', { ascending: true });

  if (error) throw error;
  return data || [];
}
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
async function getAllMatches() {
  

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .order('match_date', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function getStandings() {
  const { data, error } = await supabase
    .from('standings')
    .select('*')
    .order('group_name', { ascending: true })
    .order('position', { ascending: true });

  if (error) throw error;
  return data || [];
}
async function getMatchAnalysis(userId, userText, matchInfo) {
  // 初始化歷史
  if (!chatHistory[userId]) chatHistory[userId] = [];

  // 加入用戶訊息
  chatHistory[userId].push({ role: 'user', content: userText });

  // 只保留最近10則，避免太長
  if (chatHistory[userId].length > 5) {
    chatHistory[userId] = chatHistory[userId].slice(-10);
  }

  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content: `你是AI足球分析師糯米。\n\n📅 近期賽程：\n${matchInfo}`
      },
      ...chatHistory[userId] // 帶入完整對話歷史
    ],
  });

  const reply = completion.choices[0].message.content;

  // 把 AI 回覆也存進歷史
  chatHistory[userId].push({ role: 'assistant', content: reply });

  return reply;
}
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
      chatBarText: '⚽功能選單',
      areas: [
        { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'message', text: '賽事列表' } },
        { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: { type: 'message', text: '賽事分析' } },
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
    if (fs.existsSync('./menu.png')) {
      const imageBuffer = fs.readFileSync('./menu.png');

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
//───────────────────────────────────────────────

setupRichMenu().catch(console.error);
app.listen(8686, () => console.log('running'));