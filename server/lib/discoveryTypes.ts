// 自动发现流程（PRD 第 9 节）在搜索模块、发现编排、飞书候选池表之间共享的类型定义。

// 关键词搜索的原始结果：只带够用于「先粗筛再决定要不要花一次 resolveVideo 请求」的信息。
// 精确的点赞数/发布时间/粉丝数统一交给 resolveVideo() 之后再判定（复用现成解析逻辑，
// 而不是各自维护一套解析搜索结果详情字段的代码）。
export interface SearchHit {
  platform: "douyin" | "xhs";
  contentId: string;
  url: string;
  /** 搜索结果列表页自带的点赞数，抖音是精确值，小红书卡片上是近似值 */
  roughDiggCount: number;
}

export interface KeywordContext {
  l1: string;
  l2: string;
  l3: string;
}
