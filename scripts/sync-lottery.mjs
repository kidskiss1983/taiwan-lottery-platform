
import admin from "firebase-admin";

// ================================
// Firebase 初始化
// ================================

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ================================
// 三種彩券設定
// ================================

const games = [
  {
    name: "大樂透",
    endpoint: "Lotto649Result",
    key: "lotto649Res",
    collection: "draws_lotto649",
    mainCount: 6,
    maxNumber: 49,
    extraField: "specialNumber",
    extraMax: 49
  },
  {
    name: "今彩539",
    endpoint: "Daily539Result",
    key: "daily539Res",
    collection: "draws_lotto539",
    mainCount: 5,
    maxNumber: 39
  },
  {
    name: "威力彩",
    endpoint: "SuperLotto638Result",
    key: "superLotto638Res",
    collection: "draws_powerlottery",
    mainCount: 6,
    maxNumber: 38,
    extraField: "secondNumber",
    extraMax: 8
  }
];

// ================================
// 取得台灣目前月份及前一個月
// ================================

function getRecentMonths() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());

  const year = Number(
    parts.find(p => p.type === "year").value
  );

  const month = Number(
    parts.find(p => p.type === "month").value
  );

  const current = new Date(Date.UTC(year, month - 1, 1));

  const previous = new Date(
    Date.UTC(year, month - 2, 1)
  );

  return [previous, current].map(date =>
    `${date.getUTCFullYear()}-${String(
      date.getUTCMonth() + 1
    ).padStart(2, "0")}`
  );
}

// ================================
// 取得官方 API 資料
// ================================

async function fetchMonth(game, month) {
  const pageSize = 50;
  const allRecords = [];

  for (let pageNum = 1; ; pageNum++) {
    const url =
      `https://api.taiwanlottery.com/TLCAPIWeB/Lottery/${game.endpoint}` +
      `?period=&month=${month}&pageNum=${pageNum}&pageSize=${pageSize}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `${game.name} ${month} API 失敗：HTTP ${response.status}`
      );
    }

    const result = await response.json();
    const records = result.content?.[game.key];

    if (!Array.isArray(records)) {
      throw new Error(
        `${game.name} ${month} API 回傳格式錯誤`
      );
    }

    if (records.length === 0) break;

    allRecords.push(...records);

    if (records.length < pageSize) break;
  }

  return allRecords;
}

// ================================
// 同步單一彩券
// ================================

async function syncGame(game, months) {
  console.log(`\n========== ${game.name} ==========`);

  const existingSnapshot = await db
    .collection(game.collection)
    .get();

  const existingPeriods = new Set(
    existingSnapshot.docs.map(doc =>
      String(doc.data().period || "")
    )
  );

  console.log(`Firebase 現有資料：${existingSnapshot.size} 筆`);

  let added = 0;
  let skipped = 0;

  for (const month of months) {
    console.log(`\n讀取官方資料：${month}`);

    const records = await fetchMonth(game, month);

    console.log(`官方回傳：${records.length} 筆`);

    // 每個月份分批寫入
    for (let start = 0; start < records.length; start += 50) {
      const page = records.slice(start, start + 50);
      const batch = db.batch();

      let pageAdded = 0;

      for (const draw of page) {
        const period = String(draw.period || "");

        if (!period || period.startsWith("TEST")) {
          skipped++;
          continue;
        }

        // 已存在的期數不覆蓋
        if (existingPeriods.has(period)) {
          skipped++;
          continue;
        }

        const raw = draw.drawNumberSize;

        const expectedCount =
          game.mainCount + (game.extraField ? 1 : 0);

        if (
          !Array.isArray(raw) ||
          raw.length !== expectedCount
        ) {
          throw new Error(
            `${game.name} 第 ${period} 期號碼數量錯誤`
          );
        }

        const numbers = raw.slice(0, game.mainCount);
        const extraNumber = raw[game.mainCount];

        if (
          new Set(numbers).size !== game.mainCount ||
          numbers.some(n =>
            !Number.isInteger(n) ||
            n < 1 ||
            n > game.maxNumber
          )
        ) {
          throw new Error(
            `${game.name} 第 ${period} 期正選號碼不合法`
          );
        }

        if (
          game.extraField &&
          (
            !Number.isInteger(extraNumber) ||
            extraNumber < 1 ||
            extraNumber > game.extraMax
          )
        ) {
          throw new Error(
            `${game.name} 第 ${period} 期特別號／第二區不合法`
          );
        }

        if (
          typeof draw.lotteryDate !== "string" ||
          !draw.lotteryDate.includes("T")
        ) {
          throw new Error(
            `${game.name} 第 ${period} 期日期格式錯誤`
          );
        }

        const data = {
          period,
          date: draw.lotteryDate.split("T")[0],
          numbers: [...numbers].sort((a, b) => a - b),
          importedAt:
            admin.firestore.FieldValue.serverTimestamp()
        };

        if (game.extraField) {
          data[game.extraField] = extraNumber;
        }

        const ref = db
          .collection(game.collection)
          .doc(period);

        // create：只允許新增，不覆蓋既有文件
        batch.create(ref, data);

        existingPeriods.add(period);
        pageAdded++;
      }

      if (pageAdded > 0) {
        await batch.commit();
        added += pageAdded;
      }

      console.log(
        `${game.name}：本批新增 ${pageAdded} 筆`
      );
    }
  }

  console.log(`\n${game.name} 同步完成`);
  console.log(`新增資料：${added} 筆`);
  console.log(`跳過資料：${skipped} 筆`);
}

// ================================
// 主程式
// ================================

async function main() {
  const months = getRecentMonths();

  console.log("台灣彩券自動同步開始");
  console.log("查詢月份：", months.join("、"));

  for (const game of games) {
    await syncGame(game, months);
  }

  console.log("\n三種彩券自動同步全部完成！");
}

main().catch(error => {
  console.error("自動同步失敗：", error);
  process.exit(1);
});
