/**
 * Project-curated transfer questions, v1. Sentences and bilingual choices were
 * written together and checked for one context-specific answer. These are new
 * contexts, not the examples shown by the dictionary card. This finite pool
 * deliberately avoids assembling distractors from unreviewed dictionary rows.
 * It is project-authored material, not externally human-reviewed content.
 */
export type VerificationChoiceDraft = readonly [en: string, zh: string, explanationZh: string];
export interface VerificationQuestionDraft {
  wordId: string;
  senseId: string;
  sentence: string;
  correct: VerificationChoiceDraft;
  distractors: readonly [VerificationChoiceDraft, VerificationChoiceDraft];
  explanationZh: string;
  /** Exact reviewed sense when available; other items were checked as a whole question. */
  dictionarySenseId?: string;
  aliases?: readonly string[];
}

export const READING_VERIFICATION_QUESTION_DRAFTS: readonly VerificationQuestionDraft[] = [
  {
    wordId: 'abandon', senseId: 'give-up-plan', aliases: ['abandons', 'abandoned', 'abandoning'],
    sentence: 'We may abandon the plan to open a second shop because the rent has doubled.',
    correct: ['give up the plan', '放弃这个计划', '租金翻倍使开新店的计划可能被放弃，abandon 表示不再继续。'],
    distractors: [
      ['postpone the start of the plan', '推迟计划的开始时间', 'postpone 只是推迟，仍打算以后进行；abandon 表示放弃。'],
      ['change the cost of the plan', '修改这个计划的费用', '句中租金已经翻倍，abandon 指放弃计划，不是调整费用。'],
    ], explanationZh: 'abandon the plan 表示放弃计划，不再打算继续实施。may 说明尚未作出最终决定。',
  },
  {
    wordId: 'run', senseId: 'manage-business', dictionarySenseId: 'run-v-3', aliases: ['running', 'runs', 'ran'],
    sentence: 'After her uncle retired, Maya began to run the neighbourhood bakery.',
    correct: ['manage a business', '经营一家企业', 'Maya 接手了叔叔的面包店，run 在这里表示经营。'],
    distractors: [
      ['move quickly on foot', '快速奔跑', '句中的宾语是 bakery，不是在描述 Maya 跑步。'],
      ['stop an activity completely', '彻底停止一项活动', 'began 表示开始经营，不是停止活动。'],
    ], explanationZh: 'run a bakery 表示经营一家面包店。叔叔退休、Maya 接手这一语境确定了这个义项。',
  },
  {
    wordId: 'bank', senseId: 'river-edge', dictionarySenseId: 'bank-n-2', aliases: ['banks'],
    sentence: 'A kingfisher landed on the river bank beside our boat.',
    correct: ['land at the edge of a river', '河流边缘的陆地；河岸', 'river 和船的语境说明这里是河岸。'],
    distractors: [
      ['an institution that stores and lends money', '存款和贷款的金融机构；银行', '句中没有金融业务，river bank 指河岸。'],
      ['a vehicle used to cross water', '用来渡水的交通工具', 'boat 才是水上交通工具，bank 是岸边的陆地。'],
    ], explanationZh: 'river bank 是河岸。鸟落在岸边，船在附近，语境不涉及银行。',
  },
  {
    wordId: 'charge', senseId: 'ask-payment', dictionarySenseId: 'charge-v-1', aliases: ['charges', 'charged', 'charging'],
    sentence: 'The café does not charge customers for tap water.',
    correct: ['ask someone to pay money', '向某人收取费用', 'charge customers for water 表示向顾客收取水费。'],
    distractors: [
      ['formally accuse someone of a crime', '正式指控某人犯罪', '咖啡馆提供饮用水的语境不涉及犯罪指控。'],
      ['rush forward to attack', '向前冲去攻击', 'customers for tap water 是收费的结构，不是向前冲击。'],
    ], explanationZh: 'charge someone for something 表示为某物向某人收费。does not charge 表示这里免费提供自来水。',
  },
  {
    wordId: 'sanction', senseId: 'give-approval', dictionarySenseId: 'sanction-v-1', aliases: ['sanctions', 'sanctioned', 'sanctioning'],
    sentence: 'The board voted to sanction the project and issued written permission for work to begin.',
    correct: ['officially approve or permit', '正式批准或许可', 'written permission 明确表明董事会批准了项目。'],
    distractors: [
      ['punish someone for breaking a rule', '因违反规则而处罚某人', 'sanction 也有处罚义，但此处给予书面许可，确定的是批准义。'],
      ['keep a decision secret', '对一项决定保密', '句中董事会已经签发书面许可，并没有隐瞒决定。'],
    ], explanationZh: 'sanction 有批准和处罚等不同义项。此处的 written permission 和 work to begin 明确指向正式批准。',
  },
  {
    wordId: 'set', senseId: 'place-in-position', dictionarySenseId: 'set-v-1', aliases: ['sets', 'setting'],
    sentence: 'Please set the empty bowl on the shelf above the sink.',
    correct: ['put something in a particular place', '把某物放到指定位置', 'on the shelf 指定了碗要放的位置。'],
    distractors: [
      ['decide how much something should cost', '确定某物的价格', '句中说的是碗的位置，没有讨论售价。'],
      ['break something into small pieces', '把某物打碎成小块', '把碗放到架子上不表示打碎它。'],
    ], explanationZh: 'set the bowl on the shelf 表示把碗放在架子上。这里的 set 是放置义。',
  },
  {
    wordId: 'book', senseId: 'reserve-in-advance', aliases: ['books', 'booked', 'booking'],
    sentence: 'We need to book a room before the hotel fills up for the festival.',
    correct: ['reserve something in advance', '提前预订某物', '旅馆可能客满，因此需要提前预订房间。'],
    distractors: [
      ['return something that was borrowed', '归还借来的东西', '句中要安排住宿，不是在归还物品。'],
      ['offer something for sale', '出售某物', 'We 是需要住宿的客人，不是出售房间的一方。'],
    ], explanationZh: 'book a room 表示预订房间。before the hotel fills up 表明要提前安排住宿。',
  },
  {
    wordId: 'study', senseId: 'learn-a-subject', aliases: ['studies', 'studied', 'studying'],
    sentence: 'Lena plans to study marine biology at university next year.',
    correct: ['learn about a subject in detail', '系统学习一门学科', 'marine biology 是 Lena 准备在大学学习的学科。'],
    distractors: [
      ['teach a subject to other people', '向他人教授一门学科', 'Lena 要学习这门学科，句中没有说她要教课。'],
      ['stop taking part in a course', '退出一门课程', 'plans to study 表示计划学习，不是退课。'],
    ], explanationZh: 'study marine biology 表示学习海洋生物学；at university 进一步确定了学习学科的语境。',
  },
  {
    wordId: 'practice', senseId: 'repeat-to-improve', aliases: ['practices', 'practiced', 'practicing'],
    sentence: 'The violinist will practice the difficult passage each evening until it feels natural.',
    correct: ['repeat an activity to improve a skill', '反复练习以提高技能', 'each evening 和 until it feels natural 表明通过重复提高演奏能力。'],
    distractors: [
      ['describe an activity without doing it', '只描述一项活动而不去做', '句中小提琴手会实际反复演奏这个乐段。'],
      ['judge a finished performance', '评判一次完成的演出', '这是演出前的反复练习，不是评价演出。'],
    ], explanationZh: 'practice a passage 表示练习一个乐段。重复到熟练体现了练习这一义项。',
  },
  {
    wordId: 'progress', senseId: 'movement-towards-goal', aliases: [],
    sentence: 'The repairs are making steady progress, and two more classrooms reopened today.',
    correct: ['gradual movement towards completing a goal', '朝完成目标逐步推进；进展', '教室陆续重新开放，说明维修工作正在推进。'],
    distractors: [
      ['a decision to abandon a goal', '放弃目标的决定', '维修在继续，教室还在重新开放。'],
      ['a sudden increase in the cost', '费用突然增加', '句中没有说明费用变化，而是在报告维修进展。'],
    ], explanationZh: 'make progress 表示取得进展。更多教室恢复使用是维修目标逐步实现的证据。',
  },
  {
    wordId: 'reliable', senseId: 'can-be-trusted', aliases: [],
    sentence: 'This is a reliable bus service: it has arrived on time every morning for months.',
    correct: ['able to be trusted to work as expected', '值得信赖、能按预期运作的', '连续数月准时到达，说明这项服务可靠。'],
    distractors: [
      ['recently introduced and unfamiliar', '刚推出、尚不熟悉的', '运行了数月且表现稳定，并没有强调新推出。'],
      ['likely to stop working unexpectedly', '容易意外失效的', '稳定准时的表现不支持容易失效这一解释。'],
    ], explanationZh: 'reliable 表示可靠的。此处用长期准时到达说明这项公交服务值得信赖。',
  },
  {
    wordId: 'recognize', senseId: 'identify-from-memory', aliases: ['recognizes', 'recognized', 'recognizing'],
    sentence: 'Even in the old photograph, I can recognize my grandmother by her smile.',
    correct: ['identify someone known from before', '认出以前认识的人', '通过熟悉的笑容辨认出祖母，体现认出这一义项。'],
    distractors: [
      ['introduce someone to a stranger', '把某人介绍给陌生人', '句中是在辨认照片中的人，没有进行介绍。'],
      ['imagine someone who never existed', '想象一个从未存在的人', 'grandmother 指真实且熟悉的人，不是虚构人物。'],
    ], explanationZh: 'recognize my grandmother 表示认出祖母。by her smile 给出了辨认依据。',
  },
  {
    wordId: 'borrow', senseId: 'use-and-return', aliases: ['borrows', 'borrowed', 'borrowing'],
    sentence: 'Could I borrow your ladder this afternoon? I will bring it back before dinner.',
    correct: ['use someone else’s thing and return it later', '暂时借用别人的东西，之后归还', 'bring it back 明确说明只是暂时借用梯子。'],
    distractors: [
      ['give your own thing to someone for temporary use', '把自己的东西暂时借给别人', 'I 是使用对方梯子的人，不是出借人。'],
      ['pay to own something permanently', '付款买下某物并长期拥有', '句中承诺归还梯子，没有购买它。'],
    ], explanationZh: 'borrow 表示借入、借用。说话人暂时使用对方的梯子，并承诺当天归还。',
  },
  {
    wordId: 'reduce', senseId: 'make-less', aliases: ['reduces', 'reduced', 'reducing'],
    sentence: 'Turning off unused lights can reduce the amount of electricity the office uses.',
    correct: ['make an amount smaller', '使数量减少', '关闭不用的灯会让用电量降低。'],
    distractors: [
      ['make an amount larger', '使数量增加', '关灯减少耗电，不是增加耗电。'],
      ['keep an amount exactly the same', '让数量完全保持不变', '句中说明这一做法会改变并降低用电量。'],
    ], explanationZh: 'reduce the amount 表示减少数量；这里减少的是办公室的用电量。',
  },
  {
    wordId: 'avoid', senseId: 'keep-away-from', aliases: ['avoids', 'avoided', 'avoiding'],
    sentence: 'To avoid the traffic jam, the driver took a quieter road through the village.',
    correct: ['stay away from an unwanted situation', '避开不想遇到的情况', '司机选择另一条路，以避开堵车。'],
    distractors: [
      ['deliberately cause a problem', '故意造成一个问题', '换路是为了避开堵车，不是制造堵车。'],
      ['wait for a problem to grow worse', '等待问题变得更严重', '司机主动换路，没有等待问题恶化。'],
    ], explanationZh: 'avoid the traffic jam 表示避开交通堵塞。换走安静的道路是避开的具体行动。',
  },
  {
    wordId: 'benefit', senseId: 'useful-result', aliases: ['benefits'],
    sentence: 'One benefit of the new cycle path is a safer journey to school.',
    correct: ['a helpful or positive result', '有帮助的结果；好处', '更安全的上学路是自行车道带来的好处。'],
    distractors: [
      ['a harmful side effect', '有害的副作用', '更安全的出行是正面效果，不是危害。'],
      ['a rule that forbids an activity', '禁止一项活动的规定', '句中描述建设带来的结果，没有提出禁令。'],
    ], explanationZh: 'benefit 在这里是好处。更安全的通学旅程是新自行车道产生的正面结果。',
  },
  {
    wordId: 'improve', senseId: 'make-better', aliases: ['improves', 'improved', 'improving'],
    sentence: 'Adding clearer signs will improve the visitor experience at the museum.',
    correct: ['make something better', '使某事变得更好；改善', '更清晰的标识会改善访客的体验。'],
    distractors: [
      ['make something worse', '使某事变得更差', 'clearer signs 带来改善，不是恶化体验。'],
      ['remove something entirely', '彻底移除某物', '是在改善体验，没有取消参观体验。'],
    ], explanationZh: 'improve 表示改善、提高。增加清晰标识，让参观体验更好。',
  },
  {
    wordId: 'create', senseId: 'bring-into-existence', aliases: ['creates', 'created', 'creating'],
    sentence: 'The students will create a short film using their own script and camera.',
    correct: ['bring something new into existence', '创作或制作出新的东西', '用自己的剧本和相机制作短片，是创造新作品。'],
    distractors: [
      ['destroy something that already exists', '毁掉已经存在的东西', '学生要制作作品，不是毁掉它。'],
      ['watch something made by other people', '观看别人制作的东西', '句中学生自己制作短片，而非只观看成片。'],
    ], explanationZh: 'create a film 表示制作、创作一部影片。自己的剧本和相机表明学生是创作者。',
  },
  {
    wordId: 'protect', senseId: 'keep-safe', aliases: ['protects', 'protected', 'protecting'],
    sentence: 'The thick cover will protect the telescope from rain and dust.',
    correct: ['keep something safe from damage', '保护某物免受损坏', '罩子阻挡雨和灰尘，从而保护望远镜。'],
    distractors: [
      ['expose something to damage', '使某物暴露在可能受损的环境中', '罩子的作用是阻挡外界影响，而非暴露仪器。'],
      ['replace something with a newer model', '把某物换成更新的型号', '句中只是给望远镜加罩子，没有更换仪器。'],
    ], explanationZh: 'protect something from something 表示保护某物免受某种影响；这里是防雨、防尘。',
  },
  {
    wordId: 'discover', senseId: 'find-previously-unknown', aliases: ['discovers', 'discovered', 'discovering'],
    sentence: 'The researchers hope to discover a species that no scientist has recorded before.',
    correct: ['find something previously unknown', '发现以前未知的事物', 'no scientist has recorded before 指此前未记录的物种。'],
    distractors: [
      ['hide something so nobody can find it', '把某物藏起来让人找不到', '研究者希望找到新物种，而非隐藏它。'],
      ['invent a fictional example', '编造一个虚构的例子', '研究者寻找真实的新物种，不是在创作虚构物种。'],
    ], explanationZh: 'discover 表示发现此前未知的事物；未被科学家记录的物种符合这一语境。',
  },
  {
    wordId: 'support', senseId: 'help-person', aliases: ['supports', 'supported', 'supporting'],
    sentence: 'Her classmates will support her by helping her prepare for the debate.',
    correct: ['help someone succeed or cope', '给予帮助和支持', '帮助准备辩论是同学提供支持的具体方式。'],
    distractors: [
      ['prevent someone from taking part', '阻止某人参与', '同学在帮助她参赛，不是阻止参与。'],
      ['pretend that someone does not exist', '假装某人不存在', '同学正在主动帮助她，并没有忽视她。'],
    ], explanationZh: 'support 在这里表示支持、帮助。同学通过协助准备辩论来支持她。',
  },
  {
    wordId: 'require', senseId: 'make-necessary', aliases: ['requires', 'required', 'requiring'],
    sentence: 'The laboratory rules require visitors to wear safety glasses.',
    correct: ['make something necessary or compulsory', '要求；使某事成为必要条件', '实验室规则规定访客必须戴护目镜。'],
    distractors: [
      ['allow something without insisting on it', '允许某事，但不作要求', 'rules require 表明这是必须遵守的要求。'],
      ['forbid someone from doing something', '禁止某人做某事', '规则要求戴护目镜，并不是禁止佩戴。'],
    ], explanationZh: 'require someone to do something 表示要求某人做某事；这里是安全规定。',
  },
  {
    wordId: 'suggest', senseId: 'offer-an-idea', aliases: ['suggests', 'suggested', 'suggesting'],
    sentence: 'At the planning meeting, I will suggest holding the picnic in the park.',
    correct: ['offer an idea for people to consider', '提出一个供人考虑的想法；建议', '在筹划会议上提出野餐地点，是给出建议。'],
    distractors: [
      ['announce that an event has already happened', '宣布一件事已经发生', '会议讨论的是以后野餐的安排，不是回报已完成事件。'],
      ['reject an idea without discussing it', '不经讨论就否决一个想法', '说话人是在提出想法，并不是否决它。'],
    ], explanationZh: 'suggest holding the picnic 表示建议举行野餐，提出的地点是公园。',
  },
  {
    wordId: 'explain', senseId: 'make-understandable', aliases: ['explains', 'explained', 'explaining'],
    sentence: 'The engineer used a diagram to explain how the water filter works.',
    correct: ['make something clear and understandable', '说明清楚；解释', '工程师借助图示让人理解过滤器的原理。'],
    distractors: [
      ['keep the details hidden', '隐瞒细节', '使用图示是为了帮助理解，没有隐瞒原理。'],
      ['change the way a device works', '改变设备的工作方式', '句中是在说明原理，并没有改造过滤器。'],
    ], explanationZh: 'explain how something works 表示解释某物如何工作；图示帮助听者理解原理。',
  },
  {
    wordId: 'achieve', senseId: 'reach-a-goal', aliases: ['achieves', 'achieved', 'achieving'],
    sentence: 'After months of training, she was able to achieve her goal of swimming a kilometre.',
    correct: ['successfully reach a goal', '成功达到一个目标', '训练后能完成一公里游泳，说明目标实现了。'],
    distractors: [
      ['give up trying to reach a goal', '放弃实现目标', '句中她通过训练完成了目标，并没有放弃。'],
      ['choose a goal without working towards it', '只选定目标而不付出行动', 'months of training 和 was able to 表明她付出行动并达成目标。'],
    ], explanationZh: 'achieve a goal 表示实现目标。几个月的训练最终使她能完成一公里游泳。',
  },
  {
    wordId: 'compare', senseId: 'look-at-differences', aliases: ['compares', 'compared', 'comparing'],
    sentence: 'Before buying a laptop, compare the battery life and weight of the two models.',
    correct: ['look at similarities and differences', '比较相同点和不同点', '查看两个型号的续航和重量差异是在进行比较。'],
    distractors: [
      ['combine things into one object', '把多个东西合并成一个物体', '是在比较两个型号，没有把电脑合成一台。'],
      ['copy something exactly', '完全照样复制某物', '句中是评估型号差异，不是复制电脑。'],
    ], explanationZh: 'compare 表示比较。查看两个型号的不同指标，帮助作出购买选择。',
  },
  {
    wordId: 'choose', senseId: 'select-an-option', aliases: ['chooses', 'chose', 'chosen', 'choosing'],
    sentence: 'You may choose one of these three desserts after the meal.',
    correct: ['select from available options', '从可选项中挑选', 'one of these three 表明要从三种甜点中选一种。'],
    distractors: [
      ['prepare every available option', '把所有可选项都准备好', '句中是选择一种，不是制作全部甜点。'],
      ['refuse to consider any option', '拒绝考虑任何选项', 'may choose 给出了选择机会，没有要求拒绝全部。'],
    ], explanationZh: 'choose one of these three 表示从三项中选一项，体现挑选义。',
  },
  {
    wordId: 'continue', senseId: 'keep-going', aliases: ['continues', 'continued', 'continuing'],
    sentence: 'After a short break, the workers will continue repairing the bridge.',
    correct: ['carry on with an activity', '继续进行一项活动', '短暂休息后接着修桥，表示继续原来的工作。'],
    distractors: [
      ['stop an activity permanently', '永久停止一项活动', 'short break 后还会工作，不是永久停止。'],
      ['begin an unrelated activity', '开始一项无关的活动', 'repairing the bridge 仍然是休息前进行的工作。'],
    ], explanationZh: 'continue repairing 表示继续维修。短暂休息后，工人接着做同一项工作。',
  },
  {
    wordId: 'develop', senseId: 'grow-over-time', aliases: ['develops', 'developed', 'developing'],
    sentence: 'With regular coaching, young players can develop their skills over several seasons.',
    correct: ['grow or become more advanced over time', '逐渐发展或提高', '长期接受指导，使技能在多个赛季中逐步提高。'],
    distractors: [
      ['lose an ability completely', '完全丧失一种能力', '指导会帮助技能发展，句中没有描述能力丧失。'],
      ['keep something hidden from view', '让某物不被看见', '谈论的是技能的成长，没有隐藏东西。'],
    ], explanationZh: 'develop skills 表示发展、提升技能。over several seasons 说明这是逐渐发生的过程。',
  },
  {
    wordId: 'increase', senseId: 'make-larger', aliases: ['increases', 'increased', 'increasing'],
    sentence: 'The library will increase its opening hours from six to nine hours a day.',
    correct: ['make an amount larger', '使数量增加', '开放时间从六小时变为九小时，数量增加了。'],
    distractors: [
      ['make an amount smaller', '使数量减少', '九小时多于六小时，不能解释为减少。'],
      ['keep an amount unchanged', '让数量保持不变', '六小时变为九小时说明时长发生了变化。'],
    ], explanationZh: 'increase 表示增加。开放时长从六小时增加到九小时，直接确定了这个含义。',
  },
  {
    wordId: 'predict', senseId: 'say-what-will-happen', aliases: ['predicts', 'predicted', 'predicting'],
    sentence: 'Meteorologists use the latest satellite images to predict tomorrow’s weather.',
    correct: ['say what is likely to happen in the future', '预测将来可能发生的情况', 'tomorrow’s weather 是尚未发生的天气，需要作出预测。'],
    distractors: [
      ['describe an event that happened long ago', '描述很久以前发生的事', '句中关注明天的天气，不是过去的事件。'],
      ['cause an event to happen', '使某件事发生', '气象学家预测天气，并不能使某种天气发生。'],
    ], explanationZh: 'predict tomorrow’s weather 表示预测明天的天气；卫星图像是作出预测的依据。',
  },
  {
    wordId: 'better', senseId: 'health-has-improved', dictionarySenseId: 'better-adj-2', aliases: [],
    sentence: 'After resting for two days, Amir feels better and his fever is gone.',
    correct: ['in an improved state of health', '健康状况好转的', '休息后退烧，说明身体状况好转。'],
    distractors: [
      ['more expensive than before', '比以前更昂贵的', '句中谈健康状况，没有价格信息。'],
      ['more willing to argue', '更愿意争论的', 'fever is gone 解释的是身体恢复，不是争论倾向。'],
    ], explanationZh: 'feel better 在这一语境中表示感觉身体好些了；退烧支持健康改善这一解释。',
  },
  {
    wordId: 'take', senseId: 'need-time', dictionarySenseId: 'take-v-3', aliases: ['takes', 'took', 'taken', 'taking'],
    sentence: 'The journey will take forty minutes if the roads remain clear.',
    correct: ['need a particular amount of time', '需要或花费一定时间', 'forty minutes 表明这里说的是行程所需的时间。'],
    distractors: [
      ['remove an object from a place', '把一个物体从某处拿走', 'journey 和 minutes 描述用时，不是拿走物体。'],
      ['agree to accept an offer', '同意接受一项提议', '句中没有提议，take 用来表示花费时间。'],
    ], explanationZh: 'a journey takes forty minutes 表示一段行程需要四十分钟；这里的 take 是花费时间。',
  },
  {
    wordId: 'get', senseId: 'receive-something', dictionarySenseId: 'get-v-1', aliases: ['gets', 'got', 'getting'],
    sentence: 'Everyone who finishes the workshop will get a certificate by email.',
    correct: ['receive something', '收到或获得某物', '完成培训后会收到邮件发送的证书。'],
    distractors: [
      ['destroy something deliberately', '故意毁掉某物', '培训结束后得到证书，不是在销毁证书。'],
      ['send something to another person', '把某物发送给别人', 'Everyone 是证书的接收方，而不是发送方。'],
    ], explanationZh: 'get a certificate 表示获得、收到证书。by email 指证书的送达方式。',
  },
  {
    wordId: 'make', senseId: 'produce-an-object', dictionarySenseId: 'make-1', aliases: ['makes', 'made', 'making'],
    sentence: 'The carpenter will make a small table from the leftover wood.',
    correct: ['produce something by working on materials', '用材料制作出某物', '木匠使用剩余木料制作小桌子。'],
    distractors: [
      ['damage something beyond repair', '把某物损坏到无法修复', '木料要成为一张桌子，不是在破坏桌子。'],
      ['purchase an already finished object', '购买已经制作好的物品', 'carpenter 和 from the wood 说明是自己制作，不是购买成品。'],
    ], explanationZh: 'make a table from wood 表示用木料制作桌子，体现制作这一义项。',
  },
  {
    wordId: 'know', senseId: 'have-information', dictionarySenseId: 'know-1', aliases: ['knows', 'knew', 'known', 'knowing'],
    sentence: 'Please call the station if you do not know which platform the train leaves from.',
    correct: ['have information about something', '知道某件事的信息', '想确认列车从哪个站台出发，涉及掌握信息。'],
    distractors: [
      ['decide where something should happen', '决定某事应该在哪里发生', '乘客是在询问站台，没有决定列车的发车地点。'],
      ['move something to a different place', '把某物移到另一处', '句中没有移动物体，而是在询问信息。'],
    ], explanationZh: 'know which platform 表示知道是哪个站台。打电话可以获得尚未掌握的信息。',
  },
];
