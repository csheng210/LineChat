// sendFlow.mjs - 送訊編排(用 chat_nav 進入聊天室 + chat_send_message 打輸入框點傳送)。
//   context 由服務端注入(長駐單一 Chrome), 不自行 launch/close。
import { enterRoom } from './chat_nav.mjs';
import { sendMessage } from './lib/chat_send_message.mjs';

export async function sendUserMessage(ctx, accountName, userName, message, opts = {}) {
  if (!userName) throw new Error('使用者名稱不可為空。');
  if (!message) throw new Error('要傳送的內容不可為空。');
  await enterRoom(ctx, accountName, userName, opts);
  const sent = await sendMessage(ctx, message);
  console.log(sent ? '訊息已傳送。' : '訊息傳送未成功, 請看 reply_fail.png。');
  return sent;
}