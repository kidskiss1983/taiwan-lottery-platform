
import admin from "firebase-admin";

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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

async function importGame(game) {
  console.log(`\n開始匯入：${game.name}`);

  let total = 0;
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

      for (const draw of records) {
        const raw = draw.drawNumberSize;

        if (
          !Array.isArray(raw) ||
          raw.length !== game.mainCount +
            (game.specialField || game.secondField ? 1 : 0)
        ) {
          throw new Error(
            `${game.name} 第 ${draw.period} 期號碼數量錯誤`
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
            `${game.name} 第 ${draw.period} 期一般號碼不合法`
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
            `${game.name} 第 ${draw.period} 期特別號／第二區不合法`
          );
        }

        const data = {
          period: draw.period,
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
          .doc(String(draw.period));

        batch.set(ref, data, { merge: true });
      }

      await batch.commit();

      total += records.length;

      console.log(
        `${monthString} 第 ${pageNum} 頁：${records.length} 期`
      );

      if (records.length < pageSize) break;

      pageNum++;
    }
  }

  console.log(`${game.name} 匯入完成，共 ${total} 期`);
}
async function main() {
  for (const game of games) {
    await importGame(game);
  }

  console.log("\n2026 年歷史開獎資料匯入全部完成！");
}

main().catch(error => {
  console.error("歷史資料匯入失敗：", error);
  process.exit(1);
});
