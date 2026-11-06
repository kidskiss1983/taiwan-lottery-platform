
import admin from "firebase-admin";

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
// 匯入前檢查：保護既有測試資料
async function checkExistingDraws(game) {
  const snapshot = await db
    .collection(game.collection)
    .get();

  const testDocs = snapshot.docs.filter(doc =>
    String(doc.data().period || "").startsWith("TEST")
  );

  console.log(`\n${game.name} 現有資料檢查：`);
  console.log(`目前文件數：${snapshot.size}`);
  console.log(`測試資料數：${testDocs.length}`);

  testDocs.forEach(doc => {
    console.log(`保留測試資料：${doc.id}`);
  });

  return snapshot;
}
const games = [
  {
    name: "大樂透",
    endpoint: "Lotto649Result",
    key: "lotto649Res",
    collection: "draws_lotto649",
    mainCount: 6,
    maxNumber: 49,
    specialField: "specialNumber"
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
    secondField: "secondNumber"
  }
];
async function testGameApi(game) {
  console.log(`\n測試官方 API：${game.name}`);

  const month = "2026-10";
  const pageNum = 1;
  const pageSize = 5;

  const url =
    `https://api.taiwanlottery.com/TLCAPIWeB/Lottery/${game.endpoint}` +
    `?period=&month=${month}&pageNum=${pageNum}&pageSize=${pageSize}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `${game.name} API 測試失敗：HTTP ${response.status}`
    );
  }

  const result = await response.json();
  const records = result.content?.[game.key];

  if (!Array.isArray(records)) {
    throw new Error(`${game.name} API 回傳格式錯誤`);
  }

  console.log(`${game.name} API 測試成功`);
  console.log(`取得期數：${records.length}`);

  if (records.length > 0) {
    console.log("最新測試資料：", {
      period: records[0].period,
      lotteryDate: records[0].lotteryDate,
      drawNumberSize: records[0].drawNumberSize
    });
  }
}

async function importGame(game) {
  // 預設唯讀預覽，只有明確設定 PREVIEW_ONLY=false 才會寫入
  const previewOnly = process.env.PREVIEW_ONLY !== "false";

  const existingSnapshot = await checkExistingDraws(game);

  const existingPeriods = new Set(
    existingSnapshot.docs.map(doc =>
      String(doc.data().period || "")
    )
  );

  console.log(`\n開始${previewOnly ? "預覽" : "正式匯入"}：${game.name}`);

  let total = 0;
  let skipped = 0;
  const pageSize = 50;

  for (let month = 1; month <= 11; month++) {
    const monthString =
      `2026-${String(month).padStart(2, "0")}`;

    let pageNum = 1;

    while (true) {
      const url =
        `https://api.taiwanlottery.com/TLCAPIWeB/Lottery/${game.endpoint}` +
        `?period=&month=${monthString}&pageNum=${pageNum}&pageSize=${pageSize}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `${game.name} ${monthString} API 讀取失敗：${response.status}`
        );
      }

      const result = await response.json();
      const records = result.content?.[game.key];

      if (!Array.isArray(records)) {
        throw new Error(
          `${game.name} ${monthString} API 資料格式不正確`
        );
      }

      if (records.length === 0) break;

      const batch = db.batch();
      let pageAdded = 0;
      let pageSkipped = 0;

      for (const draw of records) {
        const period = String(draw.period);

        // 已存在的期數一律跳過
        if (existingPeriods.has(period)) {
          console.log(`跳過既有資料：${game.name} ${period}`);
          skipped++;
          pageSkipped++;
          continue;
        }

        const raw = draw.drawNumberSize;

        if (
          !Array.isArray(raw) ||
          raw.length !== game.mainCount +
            (game.specialField || game.secondField ? 1 : 0)
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
            `${game.name} 第 ${period} 期一般號碼不合法`
          );
        }

        if (
          extraNumber !== undefined &&
          (
            !Number.isInteger(extraNumber) ||
            extraNumber < 1 ||
            extraNumber > (game.specialField ? 49 : 8)
          )
        ) {
          throw new Error(
            `${game.name} 第 ${period} 期特別號／第二區不合法`
          );
        }

        const data = {
          period,
          date: draw.lotteryDate.split("T")[0],
          numbers: [...numbers].sort((a, b) => a - b),
          importedAt:
            admin.firestore.FieldValue.serverTimestamp()
        };

        if (game.specialField) {
          data.specialNumber = extraNumber;
        }

        if (game.secondField) {
          data.secondNumber = extraNumber;
        }

        const ref = db
          .collection(game.collection)
          .doc(period);

        batch.create(ref, data);

        existingPeriods.add(period);
        total++;
        pageAdded++;
      }

    // 唯讀預覽不提交 Firestore 批次
if (!previewOnly && pageAdded > 0) {
  try {
    await batch.commit();

    console.log(
      `成功寫入：${game.name} ${monthString} 第 ${pageNum} 頁`
    );

  } catch (error) {
    throw new Error(
      `${game.name} ${monthString} 第 ${pageNum} 頁寫入失敗。` +
      `為避免覆蓋既有文件，請檢查資料後重新執行。` +
      `原因：${error.message}`
    );
  }
}

      console.log(
        `${monthString} 第 ${pageNum} 頁：取得 ${records.length} 期，` +
        `預計新增 ${pageAdded} 期，跳過 ${pageSkipped} 期`
      );

      if (records.length < pageSize) break;

      pageNum++;
    }
  }

  console.log(`\n${game.name}${previewOnly ? "預覽" : "匯入"}完成`);
  console.log(`預計新增／實際新增：${total} 期`);
  console.log(`跳過既有資料：${skipped} 期`);
}

async function main() {
  for (const game of games) {
    await importGame(game);
  }

  console.log("\n2026 年歷史開獎資料匯入全部完成！");
}
async function testAllApis() {
  for (const game of games) {
    await testGameApi(game);
  }

  console.log("\n三種彩券官方 API 測試全部完成！");
}
main().catch(error => {
  console.error("歷史資料匯入失敗：", error);
  process.exit(1);
});
