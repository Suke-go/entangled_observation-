# ±Quantum: 技術仕様・アルゴリズム詳細

DESIGN.md の補足文書。Claude Code での実装に必要な具体仕様を記述する。

---

## 1. グリッド仕様（FullHD前提）

### 1.1 解像度計算

ディスプレイ: 1920 × 1080 px (FullHD)

| フォントサイズ | セル幅(px) | セル高(px) | 列数 | 行数 | 総セル数 |
|--------------|-----------|-----------|------|------|---------|
| 8px          | 5         | 9         | 384  | 120  | 46,080  |
| 10px         | 6         | 11        | 320  | 98   | 31,360  |
| 12px         | 7         | 13        | 274  | 83   | 22,742  |
| 14px         | 8         | 15        | 240  | 72   | 17,280  |
| 16px         | 10        | 17        | 192  | 63   | 12,096  |

**推奨: 10〜12px**。近距離で個々の +/- が「読める」密度感。eto.com の Minimal VJ を参照すると、画面いっぱいに高密度に文字が敷き詰められている印象。10px（320×98 ≈ 31K セル）を初期値とする。

### 1.2 フォント

```css
font-family: 'IBM Plex Mono', 'Source Code Pro', monospace;
font-weight: 400;
letter-spacing: 0;
line-height: 1.1;
```

Canvas/WebGL で描画する場合、フォントではなくビットマップで + と − のグリフを事前レンダリングし、テクスチャとして使う方がパフォーマンスが良い。

### 1.3 量子ビットとセルのマッピング

総セル数（~31K）に対し、量子ビット数 N=15〜20 では 2^N 個の状態しかシミュレーションできない。1:1 マッピングは不可能。

**解決策: グループマッピング**

```
グリッド (320×98 = 31,360 セル)
  ↓ 空間的にブロック分割
ブロックグリッド (例: 32×16 = 512 ブロック, 各ブロック 10×6 セル)
  ↓ 各ブロックが独立な2量子ビット系を持つ（計 1024 量子ビット相当）
  ↓ ただしシミュレーションは小規模量子回路を多数並列実行
```

**実装方式: タイル型量子シミュレーション**

- グリッドを M×N のタイルに分割（例: 32×16 = 512 タイル）
- 各タイル内は k 量子ビット（k=2〜4）の小規模系
- タイル間のエンタングルメントは、隣接タイル間の CNOT で実現
- **ディスプレイA⇔Bのエンタングルメント**: 対応するタイル同士が CNOT ペアを形成
- 各タイル内のセルは、そのタイルの縮約密度行列の確率分布に従って +/- を表示

この方式なら 512 × 2^4 = 512 × 16 = 8,192 複素数で済み、計算量は軽い。

---

## 2. アイトラッキング（WASM, キャリブレーション不要）

### 2.1 技術選定

**MediaPipe Face Mesh + Iris（WASM + XNNPACK バックエンド）**

- 478 個の 3D ランドマーク（468 顔 + 10 虹彩）
- ブラウザ内で完結、WASM で動作（~3MB のモデル重み）
- 個人キャリブレーション不要
- 30fps 程度（WebGL バックエンド推奨、フォールバックで WASM）

### 2.2 注視点推定アルゴリズム（キャリブレーション不要方式）

完全なスクリーン座標の推定はキャリブレーション必須だが、本作品では「大まかにどの領域を見ているか」で十分。

```
入力: 虹彩ランドマーク 5点 × 2眼 + 眼輪郭ランドマーク

Step 1: 虹彩中心の計算
  iris_center = mean(iris_landmarks[0:5])  // 左眼
  // 同様に右眼

Step 2: 眼のバウンディングボックス内での虹彩相対位置
  eye_left  = eye_contour の最左点
  eye_right = eye_contour の最右点
  eye_top   = eye_contour の最上点
  eye_bottom = eye_contour の最下点

  ratio_x = (iris_center.x - eye_left.x) / (eye_right.x - eye_left.x)
  ratio_y = (iris_center.y - eye_top.y) / (eye_bottom.y - eye_top.y)
  // ratio_x: 0.0=左端, 0.5=中央, 1.0=右端
  // ratio_y: 0.0=上端, 0.5=中央, 1.0=下端

Step 3: スクリーン座標への粗いマッピング
  // 頭の向き補正（Face Mesh の 3D ランドマークから推定）
  head_yaw   = estimate_yaw(face_landmarks)
  head_pitch = estimate_pitch(face_landmarks)

  gaze_x = ratio_x + head_yaw * k_yaw    // k_yaw: 補正係数
  gaze_y = ratio_y + head_pitch * k_pitch

  screen_x = clamp(gaze_x * screen_width,  0, screen_width)
  screen_y = clamp(gaze_y * screen_height, 0, screen_height)
```

**精度**: スクリーン全体を 3×3 〜 5×5 の領域に分割して「どのエリアを見ているか」レベル。これで十分。精密な座標は不要で、タイルレベル（32×16）の解像度に対応できればよい。

### 2.3 視線喪失の検出

- 顔が検出されない → 誰も見ていない → 再量子化開始
- 眼が閉じている（上下まぶた距離 < 閾値）→ 測定なし
- 信頼度スコアが低い → 測定強度を下げる

### 2.4 複数人対応

MediaPipe Face Mesh は `max_num_faces` パラメータで複数顔を検出可能。各顔の注視点を独立に推定し、全ての注視点を測定としてサーバーに送信。

---

## 3. ハーフトーンマッピング（画像 → 確率振幅）

### 3.1 画像前処理

```
入力: 自然画像（海など）、任意解像度
  ↓ グレースケール変換
  ↓ タイルグリッドサイズ (32×16) にリサイズ
  ↓ ヒストグラム均一化（コントラスト最適化）
  ↓ [0, 1] に正規化
出力: brightness[tile_x][tile_y] ∈ [0, 1]
```

### 3.2 輝度 → 確率振幅マッピング

各タイルの量子ビットの初期状態を画像の輝度値から設定:

```
brightness = 0.0 (黒) → |+⟩ (確率1で +) → 画面が「暗い」
brightness = 1.0 (白) → |−⟩ (確率1で −) → 画面が「明るい」
brightness = 0.5       → (|+⟩ + |−⟩)/√2  → 最大揺らぎ

具体的には:
  α = cos(brightness × π/2)
  β = sin(brightness × π/2)
  初期状態 = α|+⟩ + β|−⟩
```

### 3.3 タイル内セルの表示

各タイル内の複数セル（例: 10×6 = 60 セル）は、タイルの量子状態 ρ から確率的に +/- を決定:

```
p_plus = ⟨+|ρ|+⟩  // + になる確率
coherence = |⟨+|ρ|−⟩|  // コヒーレンス

各セルの表示:
  if (measured):
    // 確定済み: 固定表示
    display = measured_value  // '+' or '−'
    opacity_vertical_bar = (measured_value == '+') ? 1.0 : 0.0
  else:
    // 未確定: 形態的曖昧性
    // 方法A: 縦棒不透明度を p_plus に比例
    opacity_vertical_bar = p_plus

    // 方法B: 確率的点滅（フレームごとに乱数で切替）
    // coherence が高い → 切替頻度に規則的リズムを持たせる
    // coherence が低い → 完全ランダムな切替
    if (coherence > threshold):
      phase = coherence_phase[tile]  // 位相情報
      flicker_rate = base_rate × (1 + coherence × sin(time × freq + phase))
    else:
      flicker_rate = random()
```

---

## 4. 量子シミュレーション詳細

### 4.1 データ構造

```javascript
// タイル型量子シミュレーション
class QuantumTile {
  // k 量子ビットの状態ベクトル (2^k 複素数)
  stateVector: Complex[2^k]

  // エンタングルメントペア（対面ディスプレイの対応タイル）
  entangledPartner: QuantumTile | null

  // 測定結果のキャッシュ
  measuredQubits: Map<int, '+' | '-'>

  // 画像パラメータ（目標確率振幅）
  targetAmplitudes: Complex[2^k]
}

// 全体の量子系
class QuantumSystem {
  tilesA: QuantumTile[][]  // ディスプレイA (32×16)
  tilesB: QuantumTile[][]  // ディスプレイB (32×16)

  // エンタングルメント強度 (0.0 ~ 1.0)
  entanglementStrength: number

  // 画像遷移パラメータ (0.0 ~ 1.0)
  imageTransition: number
}
```

### 4.2 ゲート操作

```javascript
// Hadamard ゲート: |0⟩→|+⟩, |1⟩→|−⟩
function hadamard(stateVector, qubitIndex) {
  // 標準的な状態ベクトルシミュレーション
  // qubitIndex に対応するビットを走査して振幅を更新
}

// CNOT ゲート: エンタングルメント生成
function cnot(controlTile, targetTile, controlQubit, targetQubit) {
  // 2タイルの結合状態ベクトルに対して CNOT 適用
  // 適用後に結合状態を保持（エンタングルメント）
}

// 部分測定 (POVM)
function partialMeasure(tile, qubitIndex, strength) {
  // strength ∈ [0, 1]: 測定の強さ
  // strength = 1: 完全な射影測定（確定）
  // strength = 0: 測定なし
  // 0 < strength < 1: Kraus 演算子による弱測定

  p_plus = probability(tile.stateVector, qubitIndex, '+')
  p_minus = 1 - p_plus

  // 弱測定: 状態を完全に崩壊させず、部分的に更新
  // 強度に応じて射影と恒等演算の混合
  if (random() < strength) {
    // 測定を実行
    outcome = (random() < p_plus) ? '+' : '-'
    projectState(tile.stateVector, qubitIndex, outcome)
    tile.measuredQubits.set(qubitIndex, outcome)

    // エンタングルメントパートナーの状態も更新
    if (tile.entangledPartner) {
      updatePartnerState(tile.entangledPartner, qubitIndex, outcome)
    }
  }
}
```

### 4.3 メインループ（サーバーサイド）

```javascript
// ~30fps で実行
function simulationLoop() {
  const dt = 1/30

  // 1. 画像遷移の進行（非常にゆっくり）
  system.imageTransition += dt / IMAGE_TRANSITION_DURATION  // 例: 300秒
  if (system.imageTransition >= 1.0) {
    system.imageTransition = 0.0
    advanceToNextImage()
  }
  updateTargetAmplitudes(system.imageTransition)

  // 2. 未測定タイルに対するユニタリ発展
  //    目標振幅に向かってゆっくり回転
  for (tile of allUnmeasuredTiles()) {
    evolveTowardsTarget(tile, dt)
  }

  // 3. エンタングルメント生成
  //    一定確率で隣接タイル間・ディスプレイ間に CNOT 適用
  if (random() < system.entanglementStrength * dt) {
    selectRandomTilePair()
    applyCNOT()
  }

  // 4. 測定済みタイルの再量子化（視線が離れたもの）
  for (tile of measuredTilesNotBeingWatched()) {
    tile.reqantizationTimer += dt
    if (tile.reqantizationTimer > REQANTIZATION_DELAY) { // 例: 3秒
      resetToSuperposition(tile)
    }
  }

  // 5. 各クライアントに状態送信
  broadcastState()
}
```

### 4.4 注視データの処理

```javascript
// クライアントからの注視データ受信時
function onGazeData(clientId, gazeX, gazeY, confidence) {
  // スクリーン座標 → タイル座標
  const tileX = Math.floor(gazeX / tilePixelWidth)
  const tileY = Math.floor(gazeY / tilePixelHeight)

  // 注視点からの距離に応じた測定強度（ガウシアン）
  const sigma = GAZE_SIGMA  // タイル単位、例: 3.0
  for (tile of allTiles(clientId)) {
    const dx = tile.x - tileX
    const dy = tile.y - tileY
    const dist = Math.sqrt(dx*dx + dy*dy)
    const strength = confidence * Math.exp(-dist*dist / (2*sigma*sigma))

    if (strength > MIN_MEASUREMENT_THRESHOLD) {
      partialMeasure(tile, 0, strength)
      tile.reqantizationTimer = 0  // 視線が当たっているのでリセット
    }
  }
}
```

---

## 5. 画像素材

### 5.1 選定基準

- **自然画像（海・波・水面）**: スケール不変、テクスチャ的に豊か
- **コントラストが中程度**: 真っ黒や真っ白の領域が少ない
- **CC0 / パブリックドメイン**: 展示利用に制約なし
- **複数枚（5〜10枚）**: 変容のサイクルを回すため

### 5.2 素材ソース候補

- **Unsplash** (https://unsplash.com): CC0相当ライセンスの高品質写真。"ocean surface", "sea waves aerial", "water texture" で検索
- **Pexels** (https://pexels.com): 同様
- **NASA Earth Observatory** (https://earthobservatory.nasa.gov): 衛星画像。海面温度、渦流パターン等。パブリックドメイン
- **自前撮影**: 展示テーマに合わせた特定の海を撮影

### 5.3 画像前処理パイプライン

```bash
# 1. グレースケール変換 + タイルサイズにリサイズ
convert input.jpg -colorspace Gray -resize 32x16! -normalize tile_image.pgm

# 2. 複数画像を連番で準備
# images/sea_001.pgm, images/sea_002.pgm, ...

# 3. 画像間の遷移行列を計算（省略可、線形補間でも可）
```

### 5.4 画像遷移アルゴリズム

```javascript
// 画像A → 画像B の遷移 (t ∈ [0, 1])
function interpolateImages(imageA, imageB, t) {
  const result = new Float32Array(TILE_COLS * TILE_ROWS)
  for (let i = 0; i < result.length; i++) {
    // 単純な線形補間
    result[i] = imageA[i] * (1 - t) + imageB[i] * t

    // 代替: コサイン補間（より滑らか）
    // const s = (1 - Math.cos(t * Math.PI)) / 2
    // result[i] = imageA[i] * (1 - s) + imageB[i] * s
  }
  return result
}

// エンタングルメント強度による画像「溶解」
function dissolveImage(brightness, entanglementStrength) {
  // entanglementStrength が上がると、全てのタイルが 0.5 に近づく
  return brightness * (1 - entanglementStrength) + 0.5 * entanglementStrength
}
```

---

## 6. サーバー通信（最小構成）

### 6.1 技術スタック

```
サーバー: Node.js + ws (WebSocket ライブラリ)
通信: JSON over WebSocket
状態管理: サーバーメモリ上（永続化不要）
```

`ws` は npm の最軽量 WebSocket ライブラリ。Express 等は不要。

### 6.2 プロトコル

**クライアント → サーバー**

```json
{
  "type": "gaze",
  "clientId": "A",
  "x": 0.45,
  "y": 0.62,
  "confidence": 0.85,
  "numFaces": 1,
  "timestamp": 1711000000000
}
```

```json
{
  "type": "register",
  "clientId": "A"
}
```

**サーバー → クライアント**

```json
{
  "type": "state",
  "tiles": [
    {
      "x": 0, "y": 0,
      "pPlus": 0.73,
      "coherence": 0.41,
      "measured": false,
      "measuredValue": null
    },
    ...
  ],
  "timestamp": 1711000000000
}
```

### 6.3 最小サーバー実装の骨格

```javascript
// server.js
const WebSocket = require('ws')
const wss = new WebSocket.Server({ port: 8080 })

const clients = new Map()  // clientId → ws
const system = new QuantumSystem()

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.type === 'register') {
      clients.set(msg.clientId, ws)
    } else if (msg.type === 'gaze') {
      system.onGazeData(msg.clientId, msg.x, msg.y, msg.confidence)
    }
  })
  ws.on('close', () => {
    // クライアント切断時の処理
  })
})

// メインループ
setInterval(() => {
  system.simulationLoop()
  const state = system.getState()
  for (const [id, ws] of clients) {
    ws.send(JSON.stringify({
      type: 'state',
      tiles: state[id]
    }))
  }
}, 33)  // ~30fps
```

### 6.4 通信最適化

- 状態が変化したタイルのみ送信（差分更新）
- バイナリエンコード（Float32Array → ArrayBuffer）で帯域削減
- 30fps ではなく、変化が少ないときは送信頻度を下げる

---

## 7. レンダリング（クライアントサイド）

### 7.1 WebGL ベース

Canvas 2D の fillText は 31K セルを毎フレーム描画するには遅い。WebGL でインスタンスレンダリングを使う。

```
事前準備:
  1. '+' と '−' のグリフをビットマップテクスチャとして生成
  2. 全セル位置をバッファに格納

毎フレーム:
  1. サーバーから受信した各タイルの状態を uniform/テクスチャとして GPU に送信
  2. 各セルの頂点シェーダーで位置を決定
  3. フラグメントシェーダーで:
     - measured → '+' or '−' のテクスチャをサンプリング
     - not measured → 縦棒の opacity を pPlus で制御
       あるいは、フレームごとに確率的に '+' / '−' を切替
```

### 7.2 形態的曖昧性のシェーダー

```glsl
// fragment shader (概念)
uniform sampler2D u_plusGlyph;   // '+' のビットマップ
uniform sampler2D u_minusGlyph;  // '−' のビットマップ
uniform float u_pPlus;           // + の確率
uniform float u_coherence;       // コヒーレンス
uniform bool u_measured;         // 測定済みフラグ
uniform float u_time;

void main() {
  if (u_measured) {
    // 確定: 鮮明に表示
    vec4 glyph = (u_pPlus > 0.5)
      ? texture2D(u_plusGlyph, vUv)
      : texture2D(u_minusGlyph, vUv);
    gl_FragColor = glyph;
  } else {
    // 未確定: 形態的曖昧性
    vec4 plus = texture2D(u_plusGlyph, vUv);
    vec4 minus = texture2D(u_minusGlyph, vUv);

    // 方法: − は常に表示、+ の縦棒部分だけ pPlus で制御
    // plus と minus の差分が縦棒
    vec4 verticalBar = plus - minus;
    vec4 result = minus + verticalBar * u_pPlus;

    // コヒーレンスによる揺らぎ
    float flicker = sin(u_time * 10.0 + u_coherence * 6.28) * 0.5 + 0.5;
    result.a *= mix(0.7, 1.0, flicker * u_coherence);

    gl_FragColor = result;
  }
}
```

### 7.3 色

```css
--bg: #0a0a0c;       /* 背景: ほぼ黒 */
--char: #e0e0e0;      /* 文字: オフホワイト */
--char-dim: #404050;   /* 未確定文字: 暗いグレー */
```

モノクロ。色情報は使わない（江渡 Minimal VJ の美学）。

---

## 8. パラメータ一覧（チューニング対象）

| パラメータ | 初期値 | 単位 | 説明 |
|-----------|--------|------|------|
| `FONT_SIZE` | 10 | px | 文字サイズ |
| `TILE_COLS` | 32 | - | タイル列数 |
| `TILE_ROWS` | 16 | - | タイル行数 |
| `QUBITS_PER_TILE` | 2 | - | タイルあたり量子ビット数 |
| `GAZE_SIGMA` | 3.0 | タイル | 注視のガウシアン広がり |
| `MIN_MEASUREMENT_THRESHOLD` | 0.05 | - | 測定を実行する最小強度 |
| `REQANTIZATION_DELAY` | 3.0 | 秒 | 視線離脱後の再量子化開始遅延 |
| `REQANTIZATION_SPEED` | 0.3 | 1/秒 | 再量子化の速度 |
| `ENTANGLEMENT_STRENGTH` | 0.5 | - | エンタングルメント生成率 |
| `IMAGE_TRANSITION_DURATION` | 300 | 秒 | 画像遷移にかける時間 |
| `IMAGE_HOLD_DURATION` | 120 | 秒 | 一つの画像を保持する時間 |
| `SIMULATION_FPS` | 30 | Hz | シミュレーションのフレームレート |
| `FLICKER_BASE_RATE` | 8.0 | Hz | 未確定セルの基本点滅率 |

---

## 9. ディレクトリ構造（提案）

```
pm-quantum/
├── README.md
├── DESIGN.md                    # 設計指針（概念・メッセージ）
├── SPEC.md                      # 本文書（技術仕様）
├── server/
│   ├── package.json
│   ├── server.js                # WebSocket サーバー + メインループ
│   ├── quantum.js               # 量子シミュレーションエンジン
│   ├── measurement.js           # 測定（POVM）ロジック
│   └── image-manager.js         # 画像読み込み・遷移管理
├── client/
│   ├── index.html               # クライアントエントリーポイント
│   ├── renderer.js              # WebGL レンダラー
│   ├── gaze.js                  # MediaPipe アイトラッキング
│   ├── connection.js            # WebSocket 通信
│   ├── shaders/
│   │   ├── glyph.vert
│   │   └── glyph.frag
│   └── assets/
│       ├── plus.png             # '+' グリフテクスチャ
│       └── minus.png            # '−' グリフテクスチャ
├── images/                      # 入力画像（海など）
│   ├── sea_001.jpg
│   ├── sea_002.jpg
│   └── ...
└── tools/
    └── preprocess-images.js     # 画像前処理スクリプト
```