const games = [
  {
    name: "大樂透",
    endpoint: "Lotto649Result",
    key: "lotto649Res"
  },
  {
    name: "今彩539",
    endpoint: "Daily539Result",
    key: "daily539Res"
  },
  {
    name: "威力彩",
    endpoint: "SuperLotto638Result",
    key: "superLotto638Res"
  }
];

for (const game of games) {
  console.log(`\n========== ${game.name} ==========`);

  const url =
    `https://api.taiwanlottery.com/TLCAPIWeB/Lottery/${game.endpoint}` +
    `?period=&month=2026-01&pageNum=1&pageSize=50`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const records = data.content?.[game.key] || [];

    console.log("資料筆數：", records.length);
    console.log("第一筆資料：");

    if (records.length > 0) {
      console.log(
        JSON.stringify(records[0], null, 2)
      );
    } else {
      console.log("沒有取得資料，請檢查 API 回應。");
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error("讀取失敗：", error.message);
  }
}
