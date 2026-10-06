const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// mailNotify —— 通过 QQ 邮箱 SMTP 发送运维/数据报告邮件给管理员。
// 凭据走环境变量（铁律 RULE 5）：
//   QQ_MAIL_USER = 管理员 QQ 邮箱（发件人=收件人）
//   QQ_MAIL_PASS = QQ 邮箱授权码（非登录密码）
// 注：SMTP host/port(587 STARTTLS) 为公开服务配置，非机密，写死。
const BUILD_TAG = '2026-08-10.init';
console.log('[build] mailNotify BUILD_TAG=' + BUILD_TAG);

const nodemailer = require('nodemailer');

const SMTP = {
  host: 'smtp.qq.com',
  port: 587,
  secure: false, // 587 = STARTTLS
  auth: {
    user: process.env.QQ_MAIL_USER || '',
    pass: process.env.QQ_MAIL_PASS || ''
  }
};

exports.main = async (event) => {
  console.log('[build] mailNotify BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'send'));
  const action = (event && event.action) || 'send';
  if (action !== 'send') return { code: 400, msg: '未知 action' };

  const { subject, html, text } = event || {};
  if (!subject || (!html && !text)) return { code: 400, msg: 'subject 与 html/text 必填' };
  if (!SMTP.auth.user || !SMTP.auth.pass) {
    console.error('[mailNotify] 缺少 QQ_MAIL_USER / QQ_MAIL_PASS 环境变量');
    return { code: 500, msg: '邮件凭据未配置' };
  }

  const transporter = nodemailer.createTransport(SMTP);
  try {
    const info = await transporter.sendMail({
      from: SMTP.auth.user,
      to: SMTP.auth.user, // 发给管理员自己
      subject,
      text: text || undefined,
      html: html || undefined
    });
    console.log('[mailNotify] sent, messageId=' + (info && info.messageId));
    return { code: 200, msg: '已发送', data: { messageId: info && info.messageId } };
  } catch (e) {
    console.error('[mailNotify] send failed:', e && e.message);
    return { code: 500, msg: '发送失败：' + ((e && e.message) || e) };
  }
};
