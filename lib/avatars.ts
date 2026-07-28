// Curated persona avatars — a fixed set of pre-rendered, professional, diverse
// illustrated portraits served as static assets from the API host at
// /avatars/persona-NN.svg (public/avatars/). These are open-license (CC0)
// openPeeps illustrations rendered once at build-authoring time; runtime does NOT
// depend on any avatar-generation library and there is no per-persona image
// generation, storage, or moderation.
//
// The set is split into three gender-presentation buckets so a persona's avatar
// matches its implied gender instead of being picked at random across all faces
// (which is why "Sarah" used to resolve to a male-presenting peep). Within the
// bucket, one avatar is picked deterministically from a stable seed, so the same
// persona always resolves to the same face and the Audience band + Launch tile
// stay in sync.

const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'

export type AvatarGender = 'feminine' | 'masculine' | 'neutral'

// Static bucket map over public/avatars/persona-NN.svg. Each file was rendered
// with an intentional head/facial-hair choice for its bucket (feminine: long/
// styled hair; masculine: short hair + facial hair; neutral: androgynous textured
// hair). Keep this map in lockstep with the files if the set is ever regenerated.
const BUCKETS: Record<AvatarGender, number[]> = {
  feminine: [1, 2, 3, 4, 5, 6, 7, 8],
  masculine: [9, 10, 11, 12, 13, 14, 15, 16],
  neutral: [17, 18, 19, 20, 21, 22, 23, 24],
}
// Full set — fallback pool when a bucket is somehow empty (defensive).
const ALL = [...BUCKETS.feminine, ...BUCKETS.masculine, ...BUCKETS.neutral]

function isAvatarGender(v: unknown): v is AvatarGender {
  return v === 'feminine' || v === 'masculine' || v === 'neutral'
}

// Stable, deterministic 32-bit string hash (FNV-1a). Must NOT use Math.random or
// any per-process state — the same seed has to map to the same avatar across
// requests, deploys, and endpoints.
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    // h *= 16777619, kept in 32-bit range via Math.imul
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// Map a seed to a stable persona-NN.svg filename within the gender bucket. neutral
// (and any unknown value) uses the neutral bucket; an empty bucket falls back to
// the full set.
export function avatarFilenameForSeed(seed: string | null | undefined, gender?: AvatarGender): string {
  const s = (seed || '').trim() || 'default'
  const pool = (gender && BUCKETS[gender]?.length ? BUCKETS[gender] : BUCKETS.neutral) || ALL
  const list = pool.length ? pool : ALL
  const idx = list[hashSeed(s) % list.length]
  return `persona-${String(idx).padStart(2, '0')}.svg`
}

// Full public URL for the persona avatar chosen for this seed + gender.
export function avatarUrlForSeed(seed: string | null | undefined, gender?: AvatarGender): string {
  return `${API_URL}/avatars/${avatarFilenameForSeed(seed, gender)}`
}

// The persona is user-level: one Audience avatar (`avatar_name`) per coach, shown
// identically on the Audience step and the Launch persona tile (and every Launch
// library card, which all target that same persona). So the avatar seed is the
// persona identity, NOT the per-card id — seeding by card_id would give one coach's
// single persona a different face on every micro-training. Falls back to userId so
// the face is still stable before a persona has been named.
export function personaSeedFromAudience(audienceContent: unknown, userId: string): string {
  const c = audienceContent && typeof audienceContent === 'object' ? (audienceContent as Record<string, unknown>) : null
  const name = c && typeof c.avatar_name === 'string' ? c.avatar_name.trim() : ''
  return name || userId
}

// Resolve the persona's implied gender for avatar selection. Prefers an explicit
// avatar_gender on the profile (set by the persona generator going forward); for
// existing personas with no such field it backfills from the first token of
// avatar_name. Anything unisex, made-up, or not a person's name resolves to
// 'neutral' — we never assert a gender we aren't confident about.
export function personaGenderFromAudience(audienceContent: unknown): AvatarGender {
  const c = audienceContent && typeof audienceContent === 'object' ? (audienceContent as Record<string, unknown>) : null
  if (c && isAvatarGender(c.avatar_gender)) return c.avatar_gender
  const name = c && typeof c.avatar_name === 'string' ? c.avatar_name : ''
  return genderFromName(name)
}

// First-name -> gender lookup used to backfill avatar_gender for personas created
// before the field existed. Unisex names are deliberately omitted from BOTH lists
// (Jordan, Taylor, Alex, Casey, Riley, Morgan, Sam, Jamie, Robin, …) so they land
// on 'neutral' rather than a coin-flip. Non-names ("The Overwhelmed Coach") and
// unknown names also fall through to 'neutral'.
export function genderFromName(rawName: string): AvatarGender {
  // avatar_name is "<First> the <Descriptor>" — take the first whitespace token,
  // strip punctuation, lowercase.
  const first = (rawName || '')
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^a-zA-Z]/g, '')
    .toLowerCase()
  if (!first) return 'neutral'
  if (FEMININE_NAMES.has(first)) return 'feminine'
  if (MASCULINE_NAMES.has(first)) return 'masculine'
  return 'neutral'
}

const FEMININE_NAMES = new Set<string>([
  'sarah','sara','sarai','emma','emily','emilia','olivia','ava','sophia','sophie','isabella','isabel','isabelle',
  'mia','amelia','charlotte','harper','harper','evelyn','abigail','abby','ella','elizabeth','eliza','beth','betty',
  'sofia','avery','scarlett','grace','gracie','chloe','victoria','vicky','riley',
  'aria','lily','lilly','lila','layla','leila','nora','norah','hazel','zoey','zoe','penelope','penny','lucy',
  'stella','ellie','natalie','natalia','nathalie','leah','hannah','hana','addison','lillian','aubrey','aurora',
  'savannah','anna','ana','annie','audrey','brooklyn','bella','claire','clara','skylar','lucia','paisley',
  'everly','anna','caroline','carol','carolyn','nova','genesis','emilia','kennedy','maya','maia','willow',
  'kinsley','naomi','aaliyah','elena','elaine','sarah','gabriella','gabriela','gabby','ariana','ariel','allison','alison',
  'gianna','quinn','peyton','nevaeh','ruby','serenity','autumn','alexa','alexandra','sasha','valentina','valeria',
  'madelyn','madeline','maddie','cora','isla','eva','eve','margaret','maggie','marge','katherine','katharine','kate','katie',
  'catherine','cathy','kaitlyn','caitlin','katelyn','rachel','rachael','melanie','melody','julia','julie','juliet','juliana',
  'sadie','vivian','viviana','shelby','piper','jasmine','jazmin','josephine','josie','delilah','sara','arya',
  'brianna','bianca','melissa','molly','mackenzie','faith','amaya','isabela','eleanor','eleanora','ellen','nicole',
  'nicola','mila','morgan','jade','amara','amira','diana','dana','brooke','sydney','alexis','iris','maria','marie',
  'mary','miriam','jessica','jesse','jenna','jennifer','jen','jenny','jane','janet','janice','joan','joanna','joanne',
  'linda','barbara','barb','susan','sue','susie','karen','nancy','lisa','betty','sandra','sandy','donna','carol',
  'michelle','michele','laura','lauren','kimberly','kim','kimberley','deborah','debra','debbie','dorothy','dot',
  'amy','angela','angel','angie','ashley','anna','brenda','pamela','pam','nicole','emma','samantha','sam','sammy',
  'katherine','christine','christina','christy','tina','debra','rachel','carolyn','janet','virginia','ginny','maria',
  'heather','diane','ruth','julie','joyce','victoria','kelly','christina','joan','evelyn','judith','judy','megan','meghan',
  'meagan','cheryl','andrea','hannah','jacqueline','jackie','martha','gloria','teresa','theresa','sara','janice',
  'marie','madison','maddy','tiffany','tiff','crystal','vanessa','veronica','ronnie','erica','erika','erin','courtney',
  'monica','danielle','dani','wendy','stephanie','steph','yolanda','priya','ananya','aisha','ayesha','fatima','mariam',
  'sofia','ingrid','freya','astrid','anaya','leilani','keira','kira','kayla','kaylee','kylie','brittany','britney',
  'whitney','holly','summer','april','june','autumn','destiny','harmony','trinity','luna','esme','esmeralda','rosa',
  'rose','rosie','daisy','poppy','violet','ivy','fiona','freya','greta','greta','ophelia','beatrice','beatriz',
  'carmen','consuela','guadalupe','lucia','lucila','lupita','marisol','mercedes','pilar','ximena','yesenia','zaria',
])

const MASCULINE_NAMES = new Set<string>([
  'mike','michael','micheal','mick','john','johnny','jon','jonathan','robert','rob','bob','bobby','robbie',
  'james','jim','jimmy','jamie','william','will','bill','billy','liam','david','dave','davey','richard','rick','rich',
  'ricky','dick','joseph','joe','joey','thomas','tom','tommy','charles','charlie','chuck','christopher','chris',
  'daniel','dan','danny','matthew','matt','matty','anthony','tony','antonio','donald','don','donnie','mark',
  'marcus','marco','paul','steven','stephen','steve','andrew','andy','drew','kenneth','ken','kenny','joshua','josh',
  'kevin','brian','bryan','george','georgie','edward','ed','eddie','ted','ronald','ron','ronnie','timothy','tim','timmy',
  'jason','jay','jeffrey','jeff','geoff','ryan','jacob','jake','gary','nicholas','nick','nicolas','eric','erik','erick',
  'jonathan','stephen','larry','lawrence','justin','scott','brandon','benjamin','ben','benny','samuel','frank','franklin',
  'gregory','greg','raymond','ray','alexander','alex','alec','patrick','pat','paddy','jack','jackson','dennis','denny',
  'jerry','gerald','tyler','ty','aaron','jose','henry','hank','harry','harold','douglas','doug','peter','pete','petey',
  'adam','nathan','nate','nathaniel','zachary','zach','zack','walter','walt','kyle','harold','carl','karl','arthur','art',
  'gerald','roger','keith','jeremy','jerome','terry','terrence','lawrence','sean','shawn','christian','ethan','austin',
  'logan','noah','elijah','eli','lucas','luke','luca','mason','oliver','oli','ollie','jacob','jayden','gabriel','gabe',
  'carter','julian','wyatt','owen','caleb','nolan','hunter','isaac','ike','connor','conor','cooper','carson','easton',
  'xavier','jaxon','jaxson','dominic','dom','dominick','cole','micah','max','maximilian','maxwell','miles','myles',
  'declan','graham','leo','leon','leonard','lenny','arjun','rohan','ravi','raj','rahul','amir','omar','ali','ahmed',
  'ahmad','hassan','ibrahim','yusuf','mohammed','muhammad','mohamed','abdul','khalid','tariq','malik','marcus',
  'diego','carlos','juan','luis','miguel','javier','jorge','pedro','pablo','ricardo','rafael','rafa','fernando',
  'alejandro','sergio','manuel','manny','hector','victor','vincent','vince','angelo','giovanni','gianni','lorenzo',
  'matteo','marco','franco','bruno','hans','klaus','lars','sven','bjorn','olaf','dmitri','ivan','sergei','nikolai',
  'wei','jun','hiro','kenji','takashi','kwame','kofi','chike','emeka','tunde','desmond','marcus','reginald','reggie',
  'clifford','cliff','floyd','earl','ernest','ernie','elliot','elliott','felix','oscar','otis','rufus','silas','theodore',
  'theo','vernon','wallace','wesley','wes','curtis','clyde','dale','dwight','glenn','grover','herman','horace','hugh',
])
