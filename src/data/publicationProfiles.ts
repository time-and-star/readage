export interface PublicationProfile {
  introduction: string;
  assessment: string;
  sources: { label: string; url: string }[];
  verifiedAt: string;
}

// Introductions summarize linked material. Assessments identify app reading
// analysis or attribute named external criticism; no reader scores are invented.
const publicationProfiles: Readonly<Record<string, PublicationProfile>> = {
  "economist": {
    "introduction": "《经济学人》由苏格兰商人詹姆斯·威尔逊于1843年创办，最初投入英国废除《谷物法》的自由贸易争论。这个起点解释了它为何既报道经济，也持续参与政治讨论：贸易、政府权力和个人自由一直相互连接。今天的内容范围包括国际政治、商业、金融、科学技术和文化；它保留周刊版，同时通过网站、应用、播客和视频发布内容。[1][2]\n\n它把信息组织成几个层次。“The world this week”浓缩政治和商业要闻；“Leaders”社论明确提出刊物主张；“Briefings”与全年陆续推出的特别报告展开专题研究。数据新闻、图表和专题文章补充证据与背景。[2] 这样的分工将一周大事、问题解释与政策判断连接起来，读者既能快速了解议题，也能进入较完整的论证。\n\n多数报道不以记者个人署名，是其制度特色。Ángel Arrese在2021年在线发表的历史研究中，讨论匿名传统如何维持集体身份，又如何随透明度要求逐步放宽。[3] 集团2026年年报继续提及不署名传统，同时把 Insider 视频让读者直接接触记者视为一种演变。[4] 统一的编辑声音与记者个人的可见性，由此成为同时存在的两种要求。",
    "assessment": "从栏目结构看，它的说服力很大程度来自解释与判断的紧密衔接：一项政策被放进经济激励、制度安排和跨国比较中，报道随后转入对利弊的衡量。官方明列的自由市场、开放社会和个人自由，是理解这些判断的重要前提。[2] 统一框架能让相距很远的议题彼此连贯，也会使特定的价值取舍显得顺理成章。\n\n这套自由主义立场在历史中容纳过不同政策。历史学者 Ben Jackson 在2019年评论 Alexander Zevin 的《Liberalism at Large》时，讨论该刊在1907年后支持就业与健康保险、在1930至1940年代有保留地接受凯恩斯主义，以及1980年代支持撒切尔、里根的市场化议程。他进一步批评，该刊在2008年金融危机后的银行救助与财政紧缩问题上偏向国际金融业利益。[5] 这篇书评把刊物的思想传统与它在具体时刻支持谁、要求谁承担代价联系起来。\n\n因此，评价它的深度既要看论证是否清楚，也要看政策成本在文中怎样分配。简洁的经济解释能够揭示激励与制度后果，却可能压缩阶层经验、地方历史和价值冲突的展开空间。匿名写作又强化了整体连贯性，读者接触到的是编辑系统形成的共同声音；个别作者的犹疑、内部争论和不同地区的观察，往往退到了这种声音之后。清楚、有力的判断与被压缩的复杂性，共同构成了它的阅读特点。",
    "sources": [
      {
        "label": "[1] 集团官方：创刊与自由贸易背景",
        "url": "https://www.economistgroup.com/"
      },
      {
        "label": "[2] 刊物官方：内容层次、栏目与核心价值",
        "url": "https://www.economistgroup.com/businesses/the-economist"
      },
      {
        "label": "[3] Ángel Arrese：The evolution of anonymity in The Economist（2021年在线发表）",
        "url": "https://www.tandfonline.com/doi/abs/10.1080/13688804.2021.1888703"
      },
      {
        "label": "[4] 集团2026年报：第24页Insider与不署名传统",
        "url": "https://www.economistgroup.com/pdfs/reports/TEG_Annual_Report_2026.pdf"
      },
      {
        "label": "[5] Ben Jackson：Whose Liberalism?（2019年书评）",
        "url": "https://www.bostonreview.net/articles/ben-jackson-whose-liberalism/"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "new_yorker": {
    "introduction": "《纽约客》1925年创办时，带着面向曼哈顿都市生活的幽默杂志色彩，后来逐渐形成深度报道、政治与文化评论、小说、诗歌和漫画并置的结构。当前官网既收录每期杂志，也持续刊登新闻与文化内容。它的基本单位不只是一则消息，还可以是一个人物、一部作品、一段个人经历；报道、评论与文学创作共同构成了它的阅读节奏。[1]\n\n约翰·赫西的《广岛》提供了理解其非虚构传统的具体入口。1946年，编辑把一期杂志的主体交给这篇报道，并撤下通常的漫画。[2]文章开头没有先列武器性能，而是把原爆同一时刻六名幸存者正在做的事情并排呈现：有人读报，有人在医院走廊，有人在搬运物品。城市毁灭由此进入普通人的时间与身体，而不只是战略决策者的视野。[3]\n\n长篇写作背后还有一套核查劳动。曾任核查员的Zach Helfand在2025年回顾中写到，核查者会追问信息从何而来，联系消息来源与被提及的人，并同作者、编辑讨论争议；刊出的文字最终由编辑决定。[4]这套机制既检查名字、日期和引语，也可能促使一个过于漂亮、却证据不足的细节被删去或改写。",
    "assessment": "《广岛》的叙事力量来自尺度转换：读者先认识几个有具体工作与牵挂的人，随后才承受灾难的规模。开头让不同人物共享同一个时刻，又沿各自经历分开推进，灾难因而同时具有整体性与无法相互替代的个人感受。[3] 这种写法使报道获得场景和节奏，也把采访、观察与材料组织的要求推得很高。选择跟随谁、从哪里开场、何时结束，都在塑造事件的意义。\n\n核查劳动正嵌在这种文学性之中。核查主管 Fergus McIntosh 在2025年的文章中承认，准确并不会自动带来信任；语境、取舍和公平同样影响事实被怎样理解。[6] 这使核查的意义超出了改正名字和日期：一个生动细节能否保留，也关系到它是否让被报道者获得恰当的呈现。细密的材料与鲜明的作者声音相互支持，同时也持续相互约束。\n\n刊物对公共事务有公开的价值选择。2024年支持卡玛拉·哈里斯的社论，把反对特朗普与维护自由民主联系起来。[5] 这一编辑立场与其人物报道、文化评论中的美国社会关切相呼应。它能够给一个人的经历留下充分展开的空间；这种贴近也有自己的边界，一位作者塑造得再完整的人物，仍只是进入更大社会的一条路径。小说、漫画与幽默穿插其间，又让严肃议题之外的感受和矛盾保持可见。",
    "sources": [
      {
        "label": "[1] 刊物官方：About Us",
        "url": "https://www.newyorker.com/about/us"
      },
      {
        "label": "[2] Robert Mankoff：1946年《广岛》专期与撤下漫画",
        "url": "https://www.newyorker.com/news/news-desk/september-11th-ten-years-with-robert-mankoff"
      },
      {
        "label": "[3] John Hersey：《Hiroshima》原文（1946）",
        "url": "https://www.newyorker.com/magazine/1946/08/31/hiroshima"
      },
      {
        "label": "[4] Zach Helfand：核查部门一手回顾（2025）",
        "url": "https://www.newyorker.com/magazine/2025/09/01/the-history-of-the-new-yorkers-vaunted-fact-checking-department"
      },
      {
        "label": "[5] The Editors：支持哈里斯的社论（2024）",
        "url": "https://www.newyorker.com/magazine/2024/10/07/kamala-harris-for-president-endorsement"
      },
      {
        "label": "[6] Fergus McIntosh：What’s a Fact, Anyway?（2025）",
        "url": "https://www.newyorker.com/news/the-weekend-essay/whats-a-fact-anyway"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "atlantic": {
    "introduction": "《大西洋月刊》1857年创办于波士顿。按其官方历史，创办者反对奴隶制，也希望建立超出党派界线的文学与思想论坛。最初宣言把文学、艺术批评与政治讨论放进同一出版计划，并强调刊物对“美国理念”的理解。[1]更能说明其连续性的，是它一直把文化生活与公共制度的关系当作重要问题。\n\n当前官网的内容分布包括政治、经济、国际事务、科技、科学、健康、教育、家庭、书籍与小说。[2]报道与议论会在同一个问题周围相遇。Derek Thompson在2025年的《The Anti-Social Century》中，从餐馆吧台堆满外卖袋的见闻开场，再把时间使用调查、居家娱乐和社会交往联系起来。一个小场景逐步升级为关于美国社会的整体命题，是这类杂志长文的具体组织方式。[3]\n\n它也生产依靠一手材料成立的新闻。2025年3月，Jeffrey Goldberg报道自己被误加入美国高级官员讨论对也门军事行动的Signal群组。他在文中说明求证过程，刊载政府回应，并在初次报道中隐去部分作战细节。[4]文章由亲历事件进入权力问责，消息链、事件时间与当事方回应成为论述的基础。",
    "assessment": "它的吸引力在于愿意把零散现象组织成可争论的命题。《The Anti-Social Century》把外卖、电视、手机与交往方式放进同一论述，读者得到的是关于生活结构的解释。[3] 小场景提供感受，调查数据扩大尺度，作者再把两者引向社会判断。这种写法能让熟悉的日常显出新的关系，也让论证承担很大的跨度：共同变化的趋势怎样构成因果，不同群体的经验怎样进入整体结论，都会影响文章最终的说服力。\n\n它对公共生活的理解还包含明确的政治承诺。2024年支持哈里斯的社论，将宪政、民主与候选人是否滥用权力置于具体政策分歧之前，同时承认编辑们对哈里斯政策的评价并不一致。[5] 这表明刊物的共同立场可以围绕制度底线形成，内部仍保留其他争论。1857年宣言中的“美国理念”，在当代继续体现为对制度、自由和共同生活的追问。[1]\n\nSignal 报道又呈现了另一种力度：作者说明自己如何进入群组、如何求证，并交代首次刊发时隐去哪些细节；公共责任问题由这些具体材料逐步显现。[4] 解释性长文与材料型报道并置，使刊物既能提出宏观命题，也能介入正在发生的事件。它对美国社会有较深的历史感和问题意识；当文章将一个美国经验扩展为更普遍的文化判断时，读者也会感到这一观察位置的力量与边界。",
    "sources": [
      {
        "label": "[1] 刊物官方：创刊历史与1857年宣言",
        "url": "https://www.theatlantic.com/history/"
      },
      {
        "label": "[2] 刊物官方：当前内容栏目",
        "url": "https://www.theatlantic.com/"
      },
      {
        "label": "[3] Derek Thompson：The Anti-Social Century（2025）",
        "url": "https://www.theatlantic.com/magazine/archive/2025/02/american-loneliness-personality-politics/681091/"
      },
      {
        "label": "[4] Jeffrey Goldberg：Signal群组原始报道（2025）",
        "url": "https://www.theatlantic.com/politics/archive/2025/03/trump-administration-accidentally-texted-me-its-war-plans/682151/"
      },
      {
        "label": "[5] 编辑部：The Case for Kamala Harris（2024）",
        "url": "https://www.theatlantic.com/magazine/archive/2024/11/kamala-harris-atlantic-endorsement/679944/"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "wired": {
    "introduction": "《连线》1993年1月创刊。创办者 Louis Rossetto 在2008年的回忆中，将最初的关注点概括为推动数字革命的人、公司与观念。[1] 技术在这里同时是工具、商业力量和生活方式。今天官网把安全、政治、商业、科学、文化和评测并列，长篇、访谈与即时新闻穿插其中，持续追踪技术由谁制造、怎样进入社会，以及改变了哪些关系。[2]\n\n早期思想气质可以从 Peter Schwartz 与 Peter Leyden 在1997年发表的《The Long Boom》中看见。文章把计算机、通信、生物技术、能源与全球市场整合连接起来，描绘长期繁荣的未来，同时将其说明为一种情景，并列出可能使它破裂的风险。[3] 这样的文章参与塑造公众对未来的期待，技术报道也因此带上了鲜明的历史想象。\n\n追踪现实后果的长篇则提供另一种视角。Andy Greenberg 的2018年 NotPetya 报道，以马士基员工遇到的电脑瘫痪和港口停摆为切口，把网络攻击写进全球物流的具体运转。[7] 一段代码由此与企业组织、跨国基础设施和普通人的工作相连。与此同时，官网来源政策与评测、联盟链接说明，也反映出它面对公关、消费内容和商业收入时的不同安排。[4][5]",
    "assessment": "它内部一直存在对技术乐观主义的反思。David Karpf 在2023年的《The Curse of the Long Boom》中，批评1997年文章过快连接技术进步与普遍繁荣，也质疑共同作者 Leyden 后来仍把大方向判为成功的解释。他将问题引向分配、垄断与制度选择。[6] 这场讨论揭示了一种长期张力：新技术能够打开可能性，可能性怎样兑现、收益怎样分配，却取决于社会安排。\n\n《连线》的长篇在把抽象技术放回组织与人的关系中时，往往更有解释力。网络、安全、平台和自动化的后果，都需要沿具体使用过程展开。这样的叙述让读者看见技术赖以成立的制度与劳动，也把“创新”这一笼统词语拆成可以观察和争论的变化。它仍保留对新事物的敏感与未来想象；当一个新产品被解释成时代方向时，文章需要承担的论证也随之扩大。\n\n同一刊物里的购物与评测内容，则将技术带回个人购买和使用。官方说明网站会从联盟链接取得部分收入，并声明联盟营销项目独立于编辑和采编运作。[5] 这种模式使品牌同时以两种方式面对科技产业：新闻追问其社会权力，消费内容判断产品是否值得购买。两种视角能相互补充，也会留下张力——个人体验上的便利，与制度层面的代价，未必总能得到同一个答案。",
    "sources": [
      {
        "label": "[1] Louis Rossetto：创办者对创刊目标的回忆（2008）",
        "url": "https://www.wired.com/2008/05/ff-15th-rossetto/"
      },
      {
        "label": "[2] 刊物官方：当前新闻、长篇与评测栏目",
        "url": "https://www.wired.com/"
      },
      {
        "label": "[3] Peter Schwartz、Peter Leyden：The Long Boom原文（1997）",
        "url": "https://www.wired.com/1997/07/longboom/"
      },
      {
        "label": "[4] 刊物官方：On Background来源政策",
        "url": "https://www.wired.com/about/wired-on-background-policy/"
      },
      {
        "label": "[5] 刊物官方：联盟链接与评测政策",
        "url": "https://www.wired.com/about/affiliate-link-policy/"
      },
      {
        "label": "[6] David Karpf：The Curse of the Long Boom（2023）",
        "url": "https://www.wired.com/story/long-boom-predictions-wired/"
      },
      {
        "label": "[7] Andy Greenberg：NotPetya调查长文（2018）",
        "url": "https://www.wired.com/story/notpetya-cyberattack-ukraine-russia-code-crashed-the-world/"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "news_in_levels_a2": {
    "introduction": "News in Levels 是2011年3月启动的分级新闻网站，由 English in Levels s.r.o. 运营。它把同一题材编写成三个难度版本，选题包括国际消息、自然、体育、历史和趣闻；文字之外，文章还配有音频、难词解释与理解问题。[1][2] 它的基本单位是一则能在短时间内读完的消息，日常更新与常用表达的反复出现共同构成了它的阅读节奏。\n\n第1级围绕最常见的1000个英语词控制语言，必要的主题词另加释义。[1][2] 这种控制会直接影响叙述：人物关系尽量说清，长句拆开，背景信息随篇幅压缩。同一题材在不同级别中也会保留不同细节，改写涉及信息的重新组织。\n\n官网2026年10月13日的榴莲稿是一个直观例子：第1级介绍马来西亚向中国销售榴莲、果实自然成熟后容易变质，以及社交媒体带来的关注；第2级则进一步解释保鲜期怎样造成运输困难，经济景气怎样影响购买。[4][5] 这里比较的是两个版本的写法与信息取舍。",
    "assessment": "第1级的鲜明特点是把新闻写成一连串可立即把握的动作和状态。榴莲稿中的销售、成熟、变质和旅游都有明确主语，读者很少需要穿过插入语或复杂引语寻找主线。这种写法能保持事件轮廓，也让重复出现的词在新题材中获得具体含义。[4]\n\n语言控制同样会改变时间和因果的层次。这篇第1级用 starts 叙述2024年开始的鲜果销售，第2级改用 started；前者减少时态变化，后者让过去发生的起点与当前发展更容易区分。第1级也留下“特别的食物”这一描述，却省去了第2级关于经济景气与消费的连接。两处差异说明，简化同时作用于语言形式和读者能建立的解释关系。[4][5]\n\n它的价值集中在清晰、持续、负担较小的短篇阅读。对于复杂事件，篇幅与词汇限制也会留下较大的背景空白，因此读完一篇往往获得的是事件轮廓。原站提供的难词、音频和跨级切换，正好让这个轮廓可以逐步展开。[1][4] 本应用的 A2 标记是选读难度参考；原站使用的是自身的词汇分级方法。",
    "sources": [
      {
        "label": "[1] 官方机构与分级方法说明（2026）",
        "url": "https://www.englishinlevels.com/wp-content/uploads/2026/02/About_Us_English_in_Levels.pdf"
      },
      {
        "label": "[2] 第1级官方说明",
        "url": "https://www.newsinlevels.com/level/level-1/"
      },
      {
        "label": "[3] 关于网站与配图说明",
        "url": "https://www.newsinlevels.com/about-us/"
      },
      {
        "label": "[4] 榴莲报道：第1级对照样本",
        "url": "https://www.newsinlevels.com/products/malaysias-durian-is-becoming-popular-level-1/"
      },
      {
        "label": "[5] 榴莲报道：第2级对照样本",
        "url": "https://www.newsinlevels.com/products/malaysias-durian-is-becoming-popular-level-2/"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "news_in_levels_b1": {
    "introduction": "News in Levels 第2级属于2011年3月启动的同一分级新闻项目，由 English in Levels s.r.o. 运营。新闻与趣闻按三个级别分别改写，配以音频、难词释义和理解问题；读者可以在同一题材内切换级别，观察语言和信息怎样逐层展开。[1][2]\n\n官方将第2级的受控词汇范围设为常用2000词，并建议掌握约1000至2000词的学习者从这里开始。[1][3] 相较第1级，它有更大的空间保留因果、时间变化和条件关系；必要的主题词仍通过释义进入文章。题材可以涉及国际消息、自然或体育，文章的组织则始终服从短篇和明确主线。\n\n以官网2026年10月13日的榴莲稿为例，第2级把自然成熟、两三天内变质和运输困难接在一起，又把奢侈性消费与经济环境联系起来。promote、currently、ripen 被放入难词栏；第1级则选择另一组较基础的释义词。[4][5] 两个版本的差别同时体现在用词、句子连接与保留的解释层次上。",
    "assessment": "第2级较有价值的进步，是开始让事实之间的关系承担叙述。在榴莲稿中，“味道好但容易坏”进一步成为市场扩张的物流约束，购买行为也获得了经济条件。这比单独增加几个难词更能改变读者对事件的理解：文章从“发生了什么”向“为什么会这样”移动了一小步。[4][5]\n\n它仍保持很强的编辑引导。该稿选择生产方式、保鲜、销路和社交媒体作为主线，读者因而容易顺着商业发展的方向理解题材；种植者收入、贸易规则和行业数据没有得到同样展开。这个例子显示，短文的清楚也来自大量取舍。跨级对读能显露其中一部分取舍，但三个版本共用同一个项目，并不会增加独立的信息来源。[1][4][5]\n\n作为一种持续更新的短篇读物，第2级兼顾了现实题材与可控制的阅读负担。它的音频、难词与理解问题围绕同一篇文字工作，内容之间衔接紧密；篇幅则限制了引语、证据细节和多方争论的空间。[1][4] 本应用的 B1 标记属于选读参考，原站的等级依据是自有词汇与语法方法。",
    "sources": [
      {
        "label": "[1] 官方机构与分级方法说明（2026）",
        "url": "https://www.englishinlevels.com/wp-content/uploads/2026/02/About_Us_English_in_Levels.pdf"
      },
      {
        "label": "[2] 第2级官方入口",
        "url": "https://www.newsinlevels.com/level/level-2/"
      },
      {
        "label": "[3] 官方等级与词汇目标",
        "url": "https://www.newsinlevels.com/about-app/"
      },
      {
        "label": "[4] 榴莲报道：第2级对照样本",
        "url": "https://www.newsinlevels.com/products/malaysias-durian-is-becoming-popular-level-2/"
      },
      {
        "label": "[5] 榴莲报道：第1级对照样本",
        "url": "https://www.newsinlevels.com/products/malaysias-durian-is-becoming-popular-level-1/"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "conversation": {
    "introduction": "The Conversation于2011年在澳大利亚创办，2014年扩展到美国，随后形成多个地区版本的非营利新闻网络。它的核心安排是让学者、研究人员写自己的专长，由职业新闻编辑协助选择角度、提问和组织文章。美国版当前自述将作者资历、资助和潜在利益关系公开，并由大学、基金会和个人捐款支持运营。[1]署名、机构与利益披露一起构成了作者发言的具体位置。\n\n其2021版全球编辑准则把这种合作写成程序：作者原则上须与认可的大学或研究机构正式关联，通常只能就具有重要研究经验的主题写作；潜在利益冲突须披露，发表前由主要作者确认稿件，包括标题、图片和说明。[2]编辑与作者的关系因此既是专业知识的转换，也是权责协商。新闻编辑负责面向公众的问题意识，研究者负责确认专业内容在改写后仍准确表达自己的判断。\n\n内容从时政、健康、科学延伸到教育和文化，并不全是新论文摘要。“Curious Kids”便从儿童提问出发：威斯康星大学斯托特分校2025年转载的“天空为什么是蓝色”一文，用网球和弹珠的比喻解释光的散射，再延伸到日出日落的颜色。[3]这展示了它的另一种组织方式：先接住一个具体疑问，再逐层铺出概念。稿件在许可条件下可由其他媒体转载，知识的传播范围因而不止本站。[1]",
    "assessment": "这套机制的价值，在于让专业知识的来源和解释者同时可见。研究者能将论文与课堂中积累的问题带入公共讨论，新闻编辑则促使论述回应一个具体的公众疑问。天空颜色的文章从儿童经验进入光的散射，便体现了这种转换。[3] 作者制度也划定了发言范围：与认可机构关联的研究者更容易进入作者体系，生活经验和制度之外的知识通常经由其他途径呈现。[2]\n\n学术解释进入新闻之后，还会面对传播中的变化。Alice Fleerackers 等人在2022年发表研究，分析疫情初期41篇涉及预印本的报道及其社交传播，发现对研究尚未同行评审的提示并不稳定；文章又会被不同类型的账号继续放大。[4] 研究针对特定时期和样本，揭示的却是这类出版物需要持续处理的问题：原研究的不确定性怎样随改写和转发被保留，专业结论又怎样被理解为现实判断。\n\n平台编辑 Stephen Khan 在2021年说明预印本报道原则时，提出显著说明评审状态、在标题保留审慎措辞，并考虑请未参与研究的人撰稿，或用问答形式追问主张。[5] 这些安排让解释过程也接受质询。The Conversation 较有分量的文章，能够把已知结论、推论和仍待回答的问题分开讲清；政策评论的难处则更进一步，专业知识能解释后果，利益取舍与公共价值仍需要进入讨论。作者的专长给论述一个起点，具体证据和推理决定它能走多远。",
    "sources": [
      {
        "label": "[1] 美国版官方：历史、作者、资助与转载机制",
        "url": "https://theconversationus.substack.com/about"
      },
      {
        "label": "[2] 官方全球编辑准则（2021）：作者资格、利益披露与确认程序",
        "url": "https://cdn.theconversation.com/static_files/files/1797/The_Conversation_Global_Editorial_Guidelines_2021.pdf"
      },
      {
        "label": "[3] 大学官网转载：Curious Kids天空颜色文章（2025）",
        "url": "https://www.uwstout.edu/about-us/news-center/curious-kids-why-sky-blue"
      },
      {
        "label": "[4] Fleerackers等原始研究（2022）：疫情初期预印本报道及其社交传播",
        "url": "https://snurb.info/files/2022/Academic%20Explanatory%20Journalism.pdf"
      },
      {
        "label": "[5] Stephen Khan：How The Conversation handles pre-prints（2021）",
        "url": "https://theconversation.com/how-the-conversation-handles-pre-prints-155063"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "jstor_daily": {
    "introduction": "JSTOR Daily 于2014年创办，是由非营利学术数字图书馆 JSTOR 出版、面向普通读者的在线杂志；JSTOR 隶属非营利机构 ITHAKA。它的核心任务不是尽快复述当天新闻，而是调用学术论文与历史材料，为当代事件和文化现象补上背景。[1][2] 官网说明，作者包括学者、图书馆员、记者、评论者和科学工作者；文章经过专业编辑及事实核查，但杂志文章本身并不采用学术论文或学术图书的同行评审程序。[1]\n\n内容组织包括日常短文、较长专题、固定专栏，以及书目、教学文章和带注释的材料。Plant of the Month 从植物进入贸易、殖民、医疗或文化身份的历史；Cabinet of Curiosities 用看似边缘的物件与习俗打开社会史；Archive Adventures 则让读者看见馆藏照片、服饰或录音怎样变成叙事证据。[3][4][5] 每篇文章会链接相关 JSTOR 资料，并为读者提供免费访问这些指定材料的入口。[1] 投稿说明也直接承认：馆藏主要是档案性内容，而非刚刚发表的研究，因此选题常从过去如何塑造现在切入。[3]",
    "assessment": "它最有辨识度的编辑选择，是把一个日常疑问放回历史关系中。Plant of the Month 的葛藤文章从美国南方常见的入侵植物写起，追溯它曾被政府和推广者寄望用于防治水土流失，后来又失去政策支持的过程。植物的“有用”与“有害”由此显出各自的农业、经济和文化背景。[6] 这样的文章把冷门知识变成理解社会变化的线索。\n\n文后的资料链又给这种叙述留下了可追查的层次：读者能够看到一篇大众文章如何调用不同时期的研究，再返回原文检查材料和解释的距离。[1][6] 这既方便发现文献，也能让人注意研究自身的年代。旧文献带着当时的问题与概念，杂志作者把它们组织到今天的题目中，这一步同样包含选择和判断。\n\nJSTOR Daily 的长处在于提供有出处的背景，让熟悉的现象变得值得重新解释。馆藏以档案性资料为主，编辑也承认这一点，因此它在历史纵深和即时更新之间有明显取向。[3] 专业编辑、事实核查与免费研究入口增加了透明度；杂志文章本身不实行论文式的同行评审，文中呈现的是某位作者对一组材料的解释。[1]",
    "sources": [
      {
        "label": "[1] JSTOR Daily：机构、编辑与核查说明",
        "url": "https://daily.jstor.org/about/"
      },
      {
        "label": "[2] JSTOR 官方：2014年创刊与开放资料",
        "url": "https://about.jstor.org/blog/enhancing-student-engagement-with-jstor-daily-a-resource-for-educators/"
      },
      {
        "label": "[3] 投稿规范：馆藏范围与编辑取向",
        "url": "https://daily.jstor.org/submit/"
      },
      {
        "label": "[4] Plant of the Month 专栏",
        "url": "https://daily.jstor.org/series/plant-of-the-month/"
      },
      {
        "label": "[5] 固定专栏及 Archive Adventures",
        "url": "https://daily.jstor.org/type/column/"
      },
      {
        "label": "[6] 栏目实例：葛藤如何从水土保持方案成为入侵植物",
        "url": "https://daily.jstor.org/how-kudzu-was-supposed-to-save-the-south/"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "science_news_explores": {
    "introduction": "Science News Explores 是美国非营利机构 Society for Science 旗下的科学新闻出版物。它2003年以 Science News for Kids 之名上线，2013年改称 Science News for Students，2022年夏采用现名；同年5月开始推出每年10期的纸刊。网站持续免费发表文章，内容面向青少年、家长与教育者，覆盖天文、生命、地球、技术等领域。[1][5]\n\n它把科学新闻与解释资源紧密放在一起。Power Words 为文中术语提供词汇表；Scientists Say 逐个解释概念；Explainer 补充机制和背景；Analyze This 带读者观察图表与数据。许多文章还附研究引用、课堂问题及美国科学教育标准代码。[1][3][4] 同一个发现由此可以成为一则新闻，也可以展开成概念、证据和观察方法的学习材料。\n\n例如2026年9月的北大西洋“冷斑”文章，先提出海洋普遍变暖时局部为何变冷的问题，再介绍研究者怎样比较海温与热量交换记录，最后用两组地图和 Data Dive 问题让读者检查解释。[6] Explores 官网链接到的 Science News 新闻标准，还说明了评估研究、征询外部专家和编辑审阅的原则。[2]",
    "assessment": "这份读物较有力量的地方，是让证据进入叙述过程。冷斑文章先摆出海流供热减弱和海面散热增加两种解释，再说明什么样的数据能够帮助区分它们；读者接触到的因而包括问题、假设和比较过程。[6] 对年轻读者而言，这种组织比密集堆放结论更能呈现科学怎样推进。\n\n配套资源也具有各自的作用：术语表解决词义，地图让空间差异可见，Data Dive 要求读者自己描述趋势。它们围绕同一项研究逐步展开，使阅读能够从理解记者的说明，转向观察说明所依据的材料。[3][6] 这种设计是其教育价值的具体来源，代价则是阅读节奏比普通短新闻更慢，完整的统计与方法仍需要回到论文。\n\n简明表达还必须承受科学不确定性的压力。样本文章保留了研究者对海流变化的解释及风险判断，读者需要分清观测到的趋势、对原因的推断和对未来的预测。[6] 面向青少年的措辞能够降低进入门槛，却无法消除这些层次之间的差别。它的特色在于把研究过程组织成可读、可讨论的公共叙事；原始论文、新闻解释与课堂活动各自承担一部分理解工作。",
    "sources": [
      {
        "label": "[1] Science News Explores：沿革与出版形式",
        "url": "https://www.snexplores.org/about-us"
      },
      {
        "label": "[2] Science News：新闻标准与核查流程（Explores 官网所链接）",
        "url": "https://www.sciencenews.org/about-science-news/journalism-standards-practices"
      },
      {
        "label": "[3] 官方教育资源与内容类型",
        "url": "https://www.snexplores.org/how-to-use"
      },
      {
        "label": "[4] Scientists Say：科学概念栏目",
        "url": "https://www.snexplores.org/article-type/scientists-say"
      },
      {
        "label": "[5] 2022年集团年报：纸刊推出",
        "url": "https://www.societyforscience.org/annual-reports/2022-annual-report/snmg/"
      },
      {
        "label": "[6] 报道实例：北大西洋冷斑、数据图与 Data Dive",
        "url": "https://www.snexplores.org/article/cold-spot-atlantic-ocean-amoc"
      }
    ],
    "verifiedAt": "2026-10-20"
  },
  "mit_press_reader": {
    "introduction": "The MIT Press Reader 是麻省理工学院出版社2019年推出的免费在线杂志。出版社的发布说明进一步记载，它于当年5月上线，目标是让书籍摆脱新书季与短暂新闻周期的限制，把既有书目中的思想重新带给公众。[1][2][3] 它既不是麻省理工学院研究新闻的统一发布平台，也不只收录该校研究人员的成果；其作者与题材来自出版社广泛的出版目录，横跨哲学、历史、文化、经济、环境、科学与技术。[1][5]\n\n网站主要以 Excerpts、Essays、Interviews 等形式组织内容：有从书籍改编的摘录，也有面向普通读者的新文章和作者访谈。官网把重新发现容易被忽略的段落、解释书籍背后的故事列为办刊目标。[1][5] 例如 Finn Brunton 与 Helen Nissenbaum 的 The Fantasy of Opting Out 明确标注改编自《Obfuscation》，通过数字追踪的日常场景展开隐私、拒绝参与的代价及混淆策略。[4] 这样的文章并非一部书的中性内容提要，而是从较长论述中选出一个能独立吸引读者的问题，保留作者鲜明的分析声音。",
    "assessment": "它的特色是保留学术作者提出问题的方式。Brunton 与 Nissenbaum 的隐私书摘从一个普通人的日常出发，把交通、购物和通信留下的数据串在一起，再追问个人退出这些系统要付出什么代价。论述由生活场景进入权力不对称，使抽象的“隐私”变成社会参与的条件问题。[4] 书摘因此能够同时具有可读性与鲜明的思想方向。\n\n这个例子也显示了选段的作用：作者有关“混淆”的论证进入杂志后，被组织成一个能独立成立的疑问和回应。读者容易抓住问题，也能从署名及原书信息继续追索；方法细节、其他章节与可能的反驳则未必在这一篇中充分出现。[4] 一篇成功的摘录可以打开一本书，但它的说服力仍要放回全书论证中检验。\n\nReader 的题材与作者来自 MIT Press 自身书目，出版社的选书传统与编辑兴趣持续塑造文章面貌。[1][2] 这种关联让许多超出新闻周期的观念得到再讨论的机会，也使阅读带有明确的策展视角：读者看到的是一组被选中的问题和声音。评价它时，既可以看概念是否被讲清，也可以追问作者的前提、例子和推论是否成立；出版社提供了进入论述的路径，论述自身仍应接受具体检验。",
    "sources": [
      {
        "label": "[1] Reader 官方介绍：定位与内容形式",
        "url": "https://thereader.mitpress.mit.edu/about/"
      },
      {
        "label": "[2] 出版社发布说明：2019年5月上线与办刊目的",
        "url": "https://mitpress.mit.edu/announcing-the-mit-press-reader/"
      },
      {
        "label": "[3] 出版社沿革：Reader 创办记录",
        "url": "https://mitpress.mit.edu/history/"
      },
      {
        "label": "[4] 书摘样本：The Fantasy of Opting Out",
        "url": "https://thereader.mitpress.mit.edu/the-fantasy-of-opting-out/"
      },
      {
        "label": "[5] Reader 首页：书摘、文章、访谈栏目",
        "url": "https://thereader.mitpress.mit.edu/"
      }
    ],
    "verifiedAt": "2026-10-20"
  }
};

export function getPublicationProfile(sourceId: string): PublicationProfile | undefined {
  return Object.prototype.hasOwnProperty.call(publicationProfiles, sourceId)
    ? publicationProfiles[sourceId]
    : undefined;
}
