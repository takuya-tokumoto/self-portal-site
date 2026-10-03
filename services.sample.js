// SaaS 管理ポータルのサービス情報です。
// 画面から保存すると、このファイルは上書きされます。
// 手で編集するときは、[ ] の中を JSON の形式で書いてください。
window.SERVICES = [
  {
    "id": "github-personal",
    "name": "GitHub",
    "category": "開発",
    "accountLabel": "個人用",
    "url": "https://github.com/login",
    "loginId": "demo.personal@example.invalid",
    "password": "DEMO_ONLY_GH_P_123!yatta",
    "memo": "個人アプリの開発・公開用",
    "favorite": true
  },
  {
    "id": "github-work",
    "name": "GitHub",
    "category": "開発",
    "accountLabel": "仕事用",
    "url": "https://github.com/login",
    "loginId": "demo.work@example.invalid",
    "password": "DEMO_ONLY_GH_W_456!",
    "memo": "社内リポジトリとPRレビュー用",
    "favorite": true
  },
  {
    "id": "aws-work",
    "name": "AWS",
    "category": "インフラ",
    "accountLabel": "仕事用",
    "url": "https://signin.aws.amazon.com/console",
    "loginId": "demo-iam-user",
    "password": "DEMO_ONLY_AWS_789!yatta",
    "memo": "検証環境のEC2・S3確認用",
    "favorite": false
  },
  {
    "id": "notion-personal",
    "name": "Notion",
    "category": "ドキュメント",
    "accountLabel": "個人用",
    "url": "https://www.notion.so/login",
    "loginId": "demo.personal@example.invalid",
    "password": "DEMO_ONLY_NOTION_321!",
    "memo": "読書メモと学習ノート",
    "favorite": true
  },
  {
    "id": "slack-work",
    "name": "Slack",
    "category": "コミュニケーション",
    "accountLabel": "仕事用",
    "url": "https://slack.com/signin",
    "loginId": "demo.work@example.invalid",
    "password": "DEMO_ONLY_SLACK_654!",
    "memo": "チーム連絡とリリース通知",
    "favorite": false
  },
  {
    "id": "slack-community",
    "name": "Slack",
    "category": "コミュニケーション",
    "accountLabel": "コミュニティ用",
    "url": "https://slack.com/signin",
    "loginId": "demo.community@example.invalid",
    "password": "DEMO_ONLY_SLACK_987!",
    "memo": "勉強会コミュニティの参加用",
    "favorite": false
  }
];
