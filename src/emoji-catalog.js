// Standard emoji shortcodes for typeahead and reaction aliases.
// Shortcodes, descriptions, and tags: github/gemoji db/emoji.json (MIT).
// https://github.com/github/gemoji
// Emoji modifier bases: Unicode Emoji 16.0 emoji-data.txt.
// © 2024 Unicode®, Inc. https://www.unicode.org/terms_of_use.html
// Custom room emoji packs are not in this catalog.
//
// COMPACT ENCODING (product200 m-12, mobile first-paint budget): this file
// used to be 1870 Object.freeze() literals (~197KB raw). Each data line below
// is "emoji|primary|extras|categoryIndex|description"; the search text is
// derived as "description primary extras" except for the rows listed in
// SEARCH_OVERRIDES ("rowIndex|original search text"), whose original strings
// are kept verbatim — they carry extra terms (alien -> "ufo"), word order,
// or duplication that the picker's multi-word queries observe via
// String.includes. buildRows() reconstructs the exact EMOJI_ROWS contract
// emoji.js expects: frozen arrays of six strings [emoji, primary, extras,
// category, description, search]. No field contains "|", newline, backtick,
// or "${".
export const MODIFIER_BASE_RANGES = "261D,26F9,270A-270C,270D,1F385,1F3C2-1F3C4,1F3C7,1F3CA,1F3CB-1F3CC,1F442-1F443,1F446-1F450,1F466-1F46B,1F46C-1F46D,1F46E-1F478,1F47C,1F481-1F483,1F485-1F487,1F48F,1F491,1F4AA,1F574-1F575,1F57A,1F590,1F595-1F596,1F645-1F647,1F64B-1F64F,1F6A3,1F6B4-1F6B5,1F6B6,1F6C0,1F6CC,1F90C,1F90F,1F918,1F919-1F91E,1F91F,1F926,1F930,1F931-1F932,1F933-1F939,1F93C-1F93E,1F977,1F9B5-1F9B6,1F9B8-1F9B9,1F9BB,1F9CD-1F9CF,1F9D1-1F9DD,1FAC3-1FAC5,1FAF0-1FAF6,1FAF7-1FAF8";

const CATEGORIES = ["Smileys & Emotion","People & Body","Animals & Nature","Food & Drink","Activities","Travel & Places","Objects","Symbols","Flags"];

// emoji|primary|extras|categoryIndex|description
const ROW_DATA = `
💯|100||0|hundred points
👽|alien||0|alien
💢|anger||0|anger symbol
😠|angry||0|angry face
😧|anguished||0|anguished face
😲|astonished||0|astonished face
🖤|black_heart||0|black heart
💙|blue_heart||0|blue heart
😊|blush||0|smiling face with smiling eyes
💥|boom|collision|0|collision
💔|broken_heart||0|broken heart
🤎|brown_heart||0|brown heart
🤡|clown_face||0|clown face
🥶|cold_face||0|cold face
😰|cold_sweat||0|anxious face with sweat
😖|confounded||0|confounded face
😕|confused||0|confused face
🤠|cowboy_hat_face||0|cowboy hat face
😢|cry||0|crying face
😿|crying_cat_face||0|crying cat
💘|cupid||0|heart with arrow
🤬|cursing_face||0|face with symbols on mouth
💨|dash||0|dashing away
😞|disappointed||0|disappointed face
😥|disappointed_relieved||0|sad but relieved face
🥸|disguised_face||0|disguised face
💫|dizzy||0|dizzy
😵|dizzy_face||0|face with crossed-out eyes
🫥|dotted_line_face||0|dotted line face
🤤|drooling_face||0|drooling face
🤯|exploding_head||0|exploding head
😑|expressionless||0|expressionless face
👁️‍🗨️|eye_speech_bubble||0|eye in speech bubble
😮‍💨|face_exhaling||0|face exhaling
🥹|face_holding_back_tears||0|face holding back tears
😶‍🌫️|face_in_clouds||0|face in clouds
🫤|face_with_diagonal_mouth||0|face with diagonal mouth
🤕|face_with_head_bandage||0|face with head-bandage
🫢|face_with_open_eyes_and_hand_over_mouth||0|face with open eyes and hand over mouth
🫣|face_with_peeking_eye||0|face with peeking eye
😵‍💫|face_with_spiral_eyes||0|face with spiral eyes
🤒|face_with_thermometer||0|face with thermometer
😨|fearful||0|fearful face
😳|flushed||0|flushed face
😦|frowning||0|frowning face with open mouth
☹️|frowning_face||0|frowning face
👻|ghost||0|ghost
💝|gift_heart||0|heart with ribbon
💚|green_heart||0|green heart
🩶|grey_heart||0|grey heart
😬|grimacing||0|grimacing face
😁|grin||0|beaming face with smiling eyes
😀|grinning||0|grinning face
🤭|hand_over_mouth||0|face with hand over mouth
💩|hankey|poop shit|0|pile of poo
🙉|hear_no_evil||0|hear-no-evil monkey
❤️|heart||0|red heart
💟|heart_decoration||0|heart decoration
😍|heart_eyes||0|smiling face with heart-eyes
😻|heart_eyes_cat||0|smiling cat with heart-eyes
❤️‍🔥|heart_on_fire||0|heart on fire
💓|heartbeat||0|beating heart
💗|heartpulse||0|growing heart
❣️|heavy_heart_exclamation||0|heart exclamation
🕳️|hole||0|hole
🥵|hot_face||0|hot face
🤗|hugs||0|smiling face with open hands
😯|hushed||0|hushed face
👿|imp||0|angry face with horns
😇|innocent||0|smiling face with halo
👺|japanese_goblin||0|goblin
👹|japanese_ogre||0|ogre
😂|joy||0|face with tears of joy
😹|joy_cat||0|cat with tears of joy
💋|kiss||0|kiss mark
😗|kissing||0|kissing face
😽|kissing_cat||0|kissing cat
😚|kissing_closed_eyes||0|kissing face with closed eyes
😘|kissing_heart||0|face blowing a kiss
😙|kissing_smiling_eyes||0|kissing face with smiling eyes
😆|laughing|satisfied|0|grinning squinting face
🗨️|left_speech_bubble||0|left speech bubble
🩵|light_blue_heart||0|light blue heart
💌|love_letter||0|love letter
🤥|lying_face||0|lying face
😷|mask||0|face with medical mask
🫠|melting_face||0|melting face
❤️‍🩹|mending_heart||0|mending heart
🤑|money_mouth_face||0|money-mouth face
🧐|monocle_face||0|face with monocle
🤢|nauseated_face||0|nauseated face
🤓|nerd_face||0|nerd face
😐|neutral_face||0|neutral face
😶|no_mouth||0|face without mouth
😮|open_mouth||0|face with open mouth
🧡|orange_heart||0|orange heart
🥳|partying_face||0|partying face
😔|pensive||0|pensive face
😣|persevere||0|persevering face
🩷|pink_heart||0|pink heart
🥺|pleading_face||0|pleading face
😾|pouting_cat||0|pouting cat
💜|purple_heart||0|purple heart
😡|rage|pout|0|enraged face
🤨|raised_eyebrow||0|face with raised eyebrow
☺️|relaxed||0|smiling face
😌|relieved||0|relieved face
💞|revolving_hearts||0|revolving hearts
🗯️|right_anger_bubble||0|right anger bubble
🤖|robot||0|robot
🤣|rofl||0|rolling on the floor laughing
🙄|roll_eyes||0|face with rolling eyes
🫡|saluting_face||0|saluting face
😱|scream||0|face screaming in fear
🙀|scream_cat||0|weary cat
🙈|see_no_evil||0|see-no-evil monkey
🫨|shaking_face||0|shaking face
🤫|shushing_face||0|shushing face
💀|skull||0|skull
☠️|skull_and_crossbones||0|skull and crossbones
😴|sleeping||0|sleeping face
😪|sleepy||0|sleepy face
🙁|slightly_frowning_face||0|slightly frowning face
🙂|slightly_smiling_face||0|slightly smiling face
😄|smile||0|grinning face with smiling eyes
😸|smile_cat||0|grinning cat with smiling eyes
😃|smiley||0|grinning face with big eyes
😺|smiley_cat||0|grinning cat
🥲|smiling_face_with_tear||0|smiling face with tear
🥰|smiling_face_with_three_hearts||0|smiling face with hearts
😈|smiling_imp||0|smiling face with horns
😏|smirk||0|smirking face
😼|smirk_cat||0|cat with wry smile
🤧|sneezing_face||0|sneezing face
😭|sob||0|loudly crying face
👾|space_invader||0|alien monster
💖|sparkling_heart||0|sparkling heart
🙊|speak_no_evil||0|speak-no-evil monkey
💬|speech_balloon||0|speech balloon
🤩|star_struck||0|star-struck
😛|stuck_out_tongue||0|face with tongue
😝|stuck_out_tongue_closed_eyes||0|squinting face with tongue
😜|stuck_out_tongue_winking_eye||0|winking face with tongue
😎|sunglasses||0|smiling face with sunglasses
😓|sweat||0|downcast face with sweat
💦|sweat_drops||0|sweat droplets
😅|sweat_smile||0|grinning face with sweat
🤔|thinking||0|thinking face
💭|thought_balloon||0|thought balloon
😫|tired_face||0|tired face
😤|triumph||0|face with steam from nose
💕|two_hearts||0|two hearts
😒|unamused||0|unamused face
🙃|upside_down_face||0|upside-down face
🤮|vomiting_face||0|face vomiting
😩|weary||0|weary face
🤍|white_heart||0|white heart
😉|wink||0|winking face
🥴|woozy_face||0|woozy face
😟|worried||0|worried face
🥱|yawning_face||0|yawning face
💛|yellow_heart||0|yellow heart
😋|yum||0|face savoring food
🤪|zany_face||0|zany face
🤐|zipper_mouth_face||0|zipper-mouth face
💤|zzz||0|ZZZ
👍|+1|thumbsup|1|thumbs up
👎|-1|thumbsdown|1|thumbs down
🧑|adult||1|person
🫀|anatomical_heart||1|anatomical heart
👼|angel||1|baby angel
🧑‍🎨|artist||1|artist
🧑‍🚀|astronaut||1|astronaut
👶|baby||1|baby
👨‍🦲|bald_man||1|man: bald
👩‍🦲|bald_woman||1|woman: bald
🛀|bath||1|person taking bath
🧔|bearded_person||1|person: beard
🚴|bicyclist||1|person biking
🚴‍♂️|biking_man||1|man biking
🚴‍♀️|biking_woman||1|woman biking
🫦|biting_lip||1|biting lip
👱‍♂️|blond_haired_man||1|man: blond hair
👱|blond_haired_person||1|person: blond hair
👱‍♀️|blond_haired_woman|blonde_woman|1|woman: blond hair
🦴|bone||1|bone
⛹️‍♂️|bouncing_ball_man|basketball_man|1|man bouncing ball
⛹️|bouncing_ball_person||1|person bouncing ball
⛹️‍♀️|bouncing_ball_woman|basketball_woman|1|woman bouncing ball
🙇|bow||1|person bowing
🙇‍♂️|bowing_man||1|man bowing
🙇‍♀️|bowing_woman||1|woman bowing
👦|boy||1|boy
🧠|brain||1|brain
🤱|breast_feeding||1|breast-feeding
🕴️|business_suit_levitating||1|person in suit levitating
👤|bust_in_silhouette||1|bust in silhouette
👥|busts_in_silhouette||1|busts in silhouette
🤙|call_me_hand||1|call me hand
🤸|cartwheeling||1|person cartwheeling
🧒|child||1|child
👏|clap||1|clapping hands
🧗|climbing||1|person climbing
🧗‍♂️|climbing_man||1|man climbing
🧗‍♀️|climbing_woman||1|woman climbing
👷|construction_worker||1|construction worker
👷‍♂️|construction_worker_man||1|man construction worker
👷‍♀️|construction_worker_woman||1|woman construction worker
🧑‍🍳|cook||1|cook
👫|couple||1|woman and man holding hands
💑|couple_with_heart||1|couple with heart
👨‍❤️‍👨|couple_with_heart_man_man||1|couple with heart: man, man
👩‍❤️‍👨|couple_with_heart_woman_man||1|couple with heart: woman, man
👩‍❤️‍👩|couple_with_heart_woman_woman||1|couple with heart: woman, woman
💏|couplekiss||1|kiss
👨‍❤️‍💋‍👨|couplekiss_man_man||1|kiss: man, man
👩‍❤️‍💋‍👨|couplekiss_man_woman||1|kiss: woman, man
👩‍❤️‍💋‍👩|couplekiss_woman_woman||1|kiss: woman, woman
🤞|crossed_fingers||1|crossed fingers
👨‍🦱|curly_haired_man||1|man: curly hair
👩‍🦱|curly_haired_woman||1|woman: curly hair
👯|dancers||1|people with bunny ears
👯‍♂️|dancing_men||1|men with bunny ears
👯‍♀️|dancing_women||1|women with bunny ears
🧏‍♂️|deaf_man||1|deaf man
🧏|deaf_person||1|deaf person
🧏‍♀️|deaf_woman||1|deaf woman
🕵️|detective||1|detective
👂|ear||1|ear
🦻|ear_with_hearing_aid||1|ear with hearing aid
🧝|elf||1|elf
🧝‍♂️|elf_man||1|man elf
🧝‍♀️|elf_woman||1|woman elf
👁️|eye||1|eye
👀|eyes||1|eyes
🤦|facepalm||1|person facepalming
🧑‍🏭|factory_worker||1|factory worker
🧚|fairy||1|fairy
🧚‍♂️|fairy_man||1|man fairy
🧚‍♀️|fairy_woman||1|woman fairy
👪|family||1|family
👨‍👦|family_man_boy||1|family: man, boy
👨‍👦‍👦|family_man_boy_boy||1|family: man, boy, boy
👨‍👧|family_man_girl||1|family: man, girl
👨‍👧‍👦|family_man_girl_boy||1|family: man, girl, boy
👨‍👧‍👧|family_man_girl_girl||1|family: man, girl, girl
👨‍👨‍👦|family_man_man_boy||1|family: man, man, boy
👨‍👨‍👦‍👦|family_man_man_boy_boy||1|family: man, man, boy, boy
👨‍👨‍👧|family_man_man_girl||1|family: man, man, girl
👨‍👨‍👧‍👦|family_man_man_girl_boy||1|family: man, man, girl, boy
👨‍👨‍👧‍👧|family_man_man_girl_girl||1|family: man, man, girl, girl
👨‍👩‍👦|family_man_woman_boy||1|family: man, woman, boy
👨‍👩‍👦‍👦|family_man_woman_boy_boy||1|family: man, woman, boy, boy
👨‍👩‍👧|family_man_woman_girl||1|family: man, woman, girl
👨‍👩‍👧‍👦|family_man_woman_girl_boy||1|family: man, woman, girl, boy
👨‍👩‍👧‍👧|family_man_woman_girl_girl||1|family: man, woman, girl, girl
👩‍👦|family_woman_boy||1|family: woman, boy
👩‍👦‍👦|family_woman_boy_boy||1|family: woman, boy, boy
👩‍👧|family_woman_girl||1|family: woman, girl
👩‍👧‍👦|family_woman_girl_boy||1|family: woman, girl, boy
👩‍👧‍👧|family_woman_girl_girl||1|family: woman, girl, girl
👩‍👩‍👦|family_woman_woman_boy||1|family: woman, woman, boy
👩‍👩‍👦‍👦|family_woman_woman_boy_boy||1|family: woman, woman, boy, boy
👩‍👩‍👧|family_woman_woman_girl||1|family: woman, woman, girl
👩‍👩‍👧‍👦|family_woman_woman_girl_boy||1|family: woman, woman, girl, boy
👩‍👩‍👧‍👧|family_woman_woman_girl_girl||1|family: woman, woman, girl, girl
🧑‍🌾|farmer||1|farmer
🕵️‍♀️|female_detective||1|woman detective
🧑‍🚒|firefighter||1|firefighter
🤛|fist_left||1|left-facing fist
👊|fist_oncoming|facepunch punch|1|oncoming fist
✊|fist_raised|fist|1|raised fist
🤜|fist_right||1|right-facing fist
🦶|foot||1|foot
👣|footprints||1|footprints
🙍‍♂️|frowning_man||1|man frowning
🙍|frowning_person||1|person frowning
🙍‍♀️|frowning_woman||1|woman frowning
🧞|genie||1|genie
🧞‍♂️|genie_man||1|man genie
🧞‍♀️|genie_woman||1|woman genie
👧|girl||1|girl
🏌️|golfing||1|person golfing
🏌️‍♂️|golfing_man||1|man golfing
🏌️‍♀️|golfing_woman||1|woman golfing
💂|guard||1|guard
💂‍♂️|guardsman||1|man guard
💂‍♀️|guardswoman||1|woman guard
💇|haircut||1|person getting haircut
💇‍♂️|haircut_man||1|man getting haircut
💇‍♀️|haircut_woman||1|woman getting haircut
✋|hand|raised_hand|1|raised hand
🫰|hand_with_index_finger_and_thumb_crossed||1|hand with index finger and thumb crossed
🤾|handball_person||1|person playing handball
🤝|handshake||1|handshake
🧑‍⚕️|health_worker||1|health worker
🫶|heart_hands||1|heart hands
🏇|horse_racing||1|horse racing
🫵|index_pointing_at_the_viewer||1|index pointing at the viewer
🧑‍⚖️|judge||1|judge
🤹|juggling_person||1|person juggling
🧎‍♂️|kneeling_man||1|man kneeling
🧎|kneeling_person||1|person kneeling
🧎‍♀️|kneeling_woman||1|woman kneeling
🫲|leftwards_hand||1|leftwards hand
🫷|leftwards_pushing_hand||1|leftwards pushing hand
🦵|leg||1|leg
👄|lips||1|mouth
🧘|lotus_position||1|person in lotus position
🧘‍♂️|lotus_position_man||1|man in lotus position
🧘‍♀️|lotus_position_woman||1|woman in lotus position
🤟|love_you_gesture||1|love-you gesture
🫁|lungs||1|lungs
🧙|mage||1|mage
🧙‍♂️|mage_man||1|man mage
🧙‍♀️|mage_woman||1|woman mage
🕵️‍♂️|male_detective||1|man detective
👨|man||1|man
👨‍🎨|man_artist||1|man artist
👨‍🚀|man_astronaut||1|man astronaut
🧔‍♂️|man_beard||1|man: beard
🤸‍♂️|man_cartwheeling||1|man cartwheeling
👨‍🍳|man_cook||1|man cook
🕺|man_dancing||1|man dancing
🤦‍♂️|man_facepalming||1|man facepalming
👨‍🏭|man_factory_worker||1|man factory worker
👨‍🌾|man_farmer||1|man farmer
👨‍🍼|man_feeding_baby||1|man feeding baby
👨‍🚒|man_firefighter||1|man firefighter
👨‍⚕️|man_health_worker||1|man health worker
👨‍🦽|man_in_manual_wheelchair||1|man in manual wheelchair
👨‍🦼|man_in_motorized_wheelchair||1|man in motorized wheelchair
🤵‍♂️|man_in_tuxedo||1|man in tuxedo
👨‍⚖️|man_judge||1|man judge
🤹‍♂️|man_juggling||1|man juggling
👨‍🔧|man_mechanic||1|man mechanic
👨‍💼|man_office_worker||1|man office worker
👨‍✈️|man_pilot||1|man pilot
🤾‍♂️|man_playing_handball||1|man playing handball
🤽‍♂️|man_playing_water_polo||1|man playing water polo
👨‍🔬|man_scientist||1|man scientist
🤷‍♂️|man_shrugging||1|man shrugging
👨‍🎤|man_singer||1|man singer
👨‍🎓|man_student||1|man student
👨‍🏫|man_teacher||1|man teacher
👨‍💻|man_technologist||1|man technologist
👲|man_with_gua_pi_mao||1|person with skullcap
👨‍🦯|man_with_probing_cane||1|man with white cane
👳‍♂️|man_with_turban||1|man wearing turban
👰‍♂️|man_with_veil||1|man with veil
💆|massage||1|person getting massage
💆‍♂️|massage_man||1|man getting massage
💆‍♀️|massage_woman||1|woman getting massage
🧑‍🔧|mechanic||1|mechanic
🦾|mechanical_arm||1|mechanical arm
🦿|mechanical_leg||1|mechanical leg
🤼‍♂️|men_wrestling||1|men wrestling
🧜‍♀️|mermaid||1|mermaid
🧜‍♂️|merman||1|merman
🧜|merperson||1|merperson
🤘|metal||1|sign of the horns
🖕|middle_finger|fu|1|middle finger
🚵|mountain_bicyclist||1|person mountain biking
🚵‍♂️|mountain_biking_man||1|man mountain biking
🚵‍♀️|mountain_biking_woman||1|woman mountain biking
🤶|mrs_claus||1|Mrs. Claus
💪|muscle||1|flexed biceps
🧑‍🎄|mx_claus||1|mx claus
💅|nail_care||1|nail polish
🥷|ninja||1|ninja
🙅|no_good||1|person gesturing NO
🙅‍♂️|no_good_man|ng_man|1|man gesturing NO
🙅‍♀️|no_good_woman|ng_woman|1|woman gesturing NO
👃|nose||1|nose
🧑‍💼|office_worker||1|office worker
👌|ok_hand||1|OK hand
🙆‍♂️|ok_man||1|man gesturing OK
🙆|ok_person||1|person gesturing OK
🙆‍♀️|ok_woman||1|woman gesturing OK
🧓|older_adult||1|older person
👴|older_man||1|old man
👵|older_woman||1|old woman
👐|open_hands||1|open hands
🫳|palm_down_hand||1|palm down hand
🫴|palm_up_hand||1|palm up hand
🤲|palms_up_together||1|palms up together
🧑‍🤝‍🧑|people_holding_hands||1|people holding hands
🫂|people_hugging||1|people hugging
🧑‍🦲|person_bald||1|person: bald
🧑‍🦱|person_curly_hair||1|person: curly hair
🧑‍🍼|person_feeding_baby||1|person feeding baby
🤺|person_fencing||1|person fencing
🧑‍🦽|person_in_manual_wheelchair||1|person in manual wheelchair
🧑‍🦼|person_in_motorized_wheelchair||1|person in motorized wheelchair
🤵|person_in_tuxedo||1|person in tuxedo
🧑‍🦰|person_red_hair||1|person: red hair
🧑‍🦳|person_white_hair||1|person: white hair
🫅|person_with_crown||1|person with crown
🧑‍🦯|person_with_probing_cane||1|person with white cane
👳|person_with_turban||1|person wearing turban
👰|person_with_veil||1|person with veil
🧑‍✈️|pilot||1|pilot
🤌|pinched_fingers||1|pinched fingers
🤏|pinching_hand||1|pinching hand
👇|point_down||1|backhand index pointing down
👈|point_left||1|backhand index pointing left
👉|point_right||1|backhand index pointing right
☝️|point_up||1|index pointing up
👆|point_up_2||1|backhand index pointing up
👮|police_officer|cop|1|police officer
👮‍♂️|policeman||1|man police officer
👮‍♀️|policewoman||1|woman police officer
🙎|pouting_face||1|person pouting
🙎‍♂️|pouting_man||1|man pouting
🙎‍♀️|pouting_woman||1|woman pouting
🙏|pray||1|folded hands
🫃|pregnant_man||1|pregnant man
🫄|pregnant_person||1|pregnant person
🤰|pregnant_woman||1|pregnant woman
🤴|prince||1|prince
👸|princess||1|princess
🤚|raised_back_of_hand||1|raised back of hand
🖐️|raised_hand_with_fingers_splayed||1|hand with fingers splayed
🙌|raised_hands||1|raising hands
🙋|raising_hand||1|person raising hand
🙋‍♂️|raising_hand_man||1|man raising hand
🙋‍♀️|raising_hand_woman||1|woman raising hand
👨‍🦰|red_haired_man||1|man: red hair
👩‍🦰|red_haired_woman||1|woman: red hair
🫱|rightwards_hand||1|rightwards hand
🫸|rightwards_pushing_hand||1|rightwards pushing hand
🚣|rowboat||1|person rowing boat
🚣‍♂️|rowing_man||1|man rowing boat
🚣‍♀️|rowing_woman||1|woman rowing boat
🏃|runner|running|1|person running
🏃‍♂️|running_man||1|man running
🏃‍♀️|running_woman||1|woman running
🎅|santa||1|Santa Claus
🧖‍♂️|sauna_man||1|man in steamy room
🧖|sauna_person||1|person in steamy room
🧖‍♀️|sauna_woman||1|woman in steamy room
🧑‍🔬|scientist||1|scientist
🤳|selfie||1|selfie
🤷|shrug||1|person shrugging
🧑‍🎤|singer||1|singer
⛷️|skier||1|skier
🛌|sleeping_bed||1|person in bed
🏂|snowboarder||1|snowboarder
🗣️|speaking_head||1|speaking head
🧍‍♂️|standing_man||1|man standing
🧍|standing_person||1|person standing
🧍‍♀️|standing_woman||1|woman standing
🧑‍🎓|student||1|student
🦸|superhero||1|superhero
🦸‍♂️|superhero_man||1|man superhero
🦸‍♀️|superhero_woman||1|woman superhero
🦹|supervillain||1|supervillain
🦹‍♂️|supervillain_man||1|man supervillain
🦹‍♀️|supervillain_woman||1|woman supervillain
🏄|surfer||1|person surfing
🏄‍♂️|surfing_man||1|man surfing
🏄‍♀️|surfing_woman||1|woman surfing
🏊|swimmer||1|person swimming
🏊‍♂️|swimming_man||1|man swimming
🏊‍♀️|swimming_woman||1|woman swimming
🧑‍🏫|teacher||1|teacher
🧑‍💻|technologist||1|technologist
💁‍♂️|tipping_hand_man|sassy_man|1|man tipping hand
💁|tipping_hand_person|information_desk_person|1|person tipping hand
💁‍♀️|tipping_hand_woman|sassy_woman|1|woman tipping hand
👅|tongue||1|tongue
🦷|tooth||1|tooth
🧌|troll||1|troll
👬|two_men_holding_hands||1|men holding hands
👭|two_women_holding_hands||1|women holding hands
✌️|v||1|victory hand
🧛|vampire||1|vampire
🧛‍♂️|vampire_man||1|man vampire
🧛‍♀️|vampire_woman||1|woman vampire
🖖|vulcan_salute||1|vulcan salute
🚶|walking||1|person walking
🚶‍♂️|walking_man||1|man walking
🚶‍♀️|walking_woman||1|woman walking
🤽|water_polo||1|person playing water polo
👋|wave||1|waving hand
🏋️|weight_lifting||1|person lifting weights
🏋️‍♂️|weight_lifting_man||1|man lifting weights
🏋️‍♀️|weight_lifting_woman||1|woman lifting weights
👨‍🦳|white_haired_man||1|man: white hair
👩‍🦳|white_haired_woman||1|woman: white hair
👩|woman||1|woman
👩‍🎨|woman_artist||1|woman artist
👩‍🚀|woman_astronaut||1|woman astronaut
🧔‍♀️|woman_beard||1|woman: beard
🤸‍♀️|woman_cartwheeling||1|woman cartwheeling
👩‍🍳|woman_cook||1|woman cook
💃|woman_dancing|dancer|1|woman dancing
🤦‍♀️|woman_facepalming||1|woman facepalming
👩‍🏭|woman_factory_worker||1|woman factory worker
👩‍🌾|woman_farmer||1|woman farmer
👩‍🍼|woman_feeding_baby||1|woman feeding baby
👩‍🚒|woman_firefighter||1|woman firefighter
👩‍⚕️|woman_health_worker||1|woman health worker
👩‍🦽|woman_in_manual_wheelchair||1|woman in manual wheelchair
👩‍🦼|woman_in_motorized_wheelchair||1|woman in motorized wheelchair
🤵‍♀️|woman_in_tuxedo||1|woman in tuxedo
👩‍⚖️|woman_judge||1|woman judge
🤹‍♀️|woman_juggling||1|woman juggling
👩‍🔧|woman_mechanic||1|woman mechanic
👩‍💼|woman_office_worker||1|woman office worker
👩‍✈️|woman_pilot||1|woman pilot
🤾‍♀️|woman_playing_handball||1|woman playing handball
🤽‍♀️|woman_playing_water_polo||1|woman playing water polo
👩‍🔬|woman_scientist||1|woman scientist
🤷‍♀️|woman_shrugging||1|woman shrugging
👩‍🎤|woman_singer||1|woman singer
👩‍🎓|woman_student||1|woman student
👩‍🏫|woman_teacher||1|woman teacher
👩‍💻|woman_technologist||1|woman technologist
🧕|woman_with_headscarf||1|woman with headscarf
👩‍🦯|woman_with_probing_cane||1|woman with white cane
👳‍♀️|woman_with_turban||1|woman wearing turban
👰‍♀️|woman_with_veil|bride_with_veil|1|woman with veil
🤼‍♀️|women_wrestling||1|women wrestling
🤼|wrestling||1|people wrestling
✍️|writing_hand||1|writing hand
🧟|zombie||1|zombie
🧟‍♂️|zombie_man||1|man zombie
🧟‍♀️|zombie_woman||1|woman zombie
🐜|ant||2|ant
🐤|baby_chick||2|baby chick
🦡|badger||2|badger
🦇|bat||2|bat
🐻|bear||2|bear
🦫|beaver||2|beaver
🐝|bee|honeybee|2|honeybee
🪲|beetle||2|beetle
🐦|bird||2|bird
🦬|bison||2|bison
🐦‍⬛|black_bird||2|black bird
🐈‍⬛|black_cat||2|black cat
🌼|blossom||2|blossom
🐡|blowfish||2|blowfish
🐗|boar||2|boar
💐|bouquet||2|bouquet
🐛|bug||2|bug
🦋|butterfly||2|butterfly
🌵|cactus||2|cactus
🐫|camel||2|two-hump camel
🐱|cat||2|cat face
🐈|cat2||2|cat
🌸|cherry_blossom||2|cherry blossom
🐔|chicken||2|chicken
🐿️|chipmunk||2|chipmunk
🪳|cockroach||2|cockroach
🪸|coral||2|coral
🐮|cow||2|cow face
🐄|cow2||2|cow
🦗|cricket||2|cricket
🐊|crocodile||2|crocodile
🌳|deciduous_tree||2|deciduous tree
🦌|deer||2|deer
🦤|dodo||2|dodo
🐶|dog||2|dog face
🐕|dog2||2|dog
🐬|dolphin|flipper|2|dolphin
🫏|donkey||2|donkey
🕊️|dove||2|dove
🐉|dragon||2|dragon
🐲|dragon_face||2|dragon face
🐪|dromedary_camel||2|camel
🦆|duck||2|duck
🦅|eagle||2|eagle
🌾|ear_of_rice||2|sheaf of rice
🐘|elephant||2|elephant
🪹|empty_nest||2|empty nest
🌲|evergreen_tree||2|evergreen tree
🍂|fallen_leaf||2|fallen leaf
🪶|feather||2|feather
🐾|feet|paw_prints|2|paw prints
🐟|fish||2|fish
🦩|flamingo||2|flamingo
🪰|fly||2|fly
🍀|four_leaf_clover||2|four leaf clover
🦊|fox_face||2|fox
🐸|frog||2|frog
🦒|giraffe||2|giraffe
🐐|goat||2|goat
🪿|goose||2|goose
🦍|gorilla||2|gorilla
🦮|guide_dog||2|guide dog
🐹|hamster||2|hamster
🐥|hatched_chick||2|front-facing baby chick
🐣|hatching_chick||2|hatching chick
🦔|hedgehog||2|hedgehog
🌿|herb||2|herb
🌺|hibiscus||2|hibiscus
🦛|hippopotamus||2|hippopotamus
🐴|horse||2|horse face
🪻|hyacinth||2|hyacinth
🪼|jellyfish||2|jellyfish
🦘|kangaroo||2|kangaroo
🐨|koala||2|koala
🐞|lady_beetle||2|lady beetle
🍃|leaves||2|leaf fluttering in wind
🐆|leopard||2|leopard
🦁|lion||2|lion
🦎|lizard||2|lizard
🦙|llama||2|llama
🪷|lotus||2|lotus
🦣|mammoth||2|mammoth
🍁|maple_leaf||2|maple leaf
🦠|microbe||2|microbe
🐒|monkey||2|monkey
🐵|monkey_face||2|monkey face
🫎|moose||2|moose
🦟|mosquito||2|mosquito
🐭|mouse||2|mouse face
🐁|mouse2||2|mouse
🍄|mushroom||2|mushroom
🪺|nest_with_eggs||2|nest with eggs
🐙|octopus||2|octopus
🦧|orangutan||2|orangutan
🦦|otter||2|otter
🦉|owl||2|owl
🐂|ox||2|ox
🌴|palm_tree||2|palm tree
🐼|panda_face||2|panda
🦜|parrot||2|parrot
🦚|peacock||2|peacock
🐧|penguin||2|penguin
🐷|pig||2|pig face
🐖|pig2||2|pig
🐽|pig_nose||2|pig nose
🐻‍❄️|polar_bear||2|polar bear
🐩|poodle||2|poodle
🪴|potted_plant||2|potted plant
🐰|rabbit||2|rabbit face
🐇|rabbit2||2|rabbit
🦝|raccoon||2|raccoon
🐎|racehorse||2|horse
🐏|ram||2|ram
🐀|rat||2|rat
🦏|rhinoceros||2|rhinoceros
🐓|rooster||2|rooster
🌹|rose||2|rose
🏵️|rosette||2|rosette
🦕|sauropod||2|sauropod
🦂|scorpion||2|scorpion
🦭|seal||2|seal
🌱|seedling||2|seedling
🐕‍🦺|service_dog||2|service dog
☘️|shamrock||2|shamrock
🦈|shark||2|shark
🐑|sheep||2|ewe
🐚|shell||2|spiral shell
🦨|skunk||2|skunk
🦥|sloth||2|sloth
🐌|snail||2|snail
🐍|snake||2|snake
🕷️|spider||2|spider
🕸️|spider_web||2|spider web
🌻|sunflower||2|sunflower
🦢|swan||2|swan
🦖|t-rex||2|T-Rex
🐯|tiger||2|tiger face
🐅|tiger2||2|tiger
🐠|tropical_fish||2|tropical fish
🌷|tulip||2|tulip
🦃|turkey||2|turkey
🐢|turtle||2|turtle
🦄|unicorn||2|unicorn
🐃|water_buffalo||2|water buffalo
🐳|whale||2|spouting whale
🐋|whale2||2|whale
💮|white_flower||2|white flower
🥀|wilted_flower||2|wilted flower
🪽|wing||2|wing
🐺|wolf||2|wolf
🪱|worm||2|worm
🦓|zebra||2|zebra
🏺|amphora||3|amphora
🍎|apple||3|red apple
🥑|avocado||3|avocado
🍼|baby_bottle||3|baby bottle
🥓|bacon||3|bacon
🥯|bagel||3|bagel
🥖|baguette_bread||3|baguette bread
🍌|banana||3|banana
🫘|beans||3|beans
🍺|beer||3|beer mug
🍻|beers||3|clinking beer mugs
🫑|bell_pepper||3|bell pepper
🍱|bento||3|bento box
🧃|beverage_box||3|beverage box
🎂|birthday||3|birthday cake
🫐|blueberries||3|blueberries
🥣|bowl_with_spoon||3|bowl with spoon
🍞|bread||3|bread
🥦|broccoli||3|broccoli
🧋|bubble_tea||3|bubble tea
🌯|burrito||3|burrito
🧈|butter||3|butter
🍰|cake||3|shortcake
🍬|candy||3|candy
🥫|canned_food||3|canned food
🥕|carrot||3|carrot
🍾|champagne||3|bottle with popping cork
🧀|cheese||3|cheese wedge
🍒|cherries||3|cherries
🌰|chestnut||3|chestnut
🍫|chocolate_bar||3|chocolate bar
🥢|chopsticks||3|chopsticks
🥂|clinking_glasses||3|clinking glasses
🍸|cocktail||3|cocktail glass
🥥|coconut||3|coconut
☕|coffee||3|hot beverage
🍪|cookie||3|cookie
🌽|corn||3|ear of corn
🦀|crab||3|crab
🥐|croissant||3|croissant
🥒|cucumber||3|cucumber
🥤|cup_with_straw||3|cup with straw
🧁|cupcake||3|cupcake
🍛|curry||3|curry rice
🍮|custard||3|custard
🥩|cut_of_meat||3|cut of meat
🍡|dango||3|dango
🍩|doughnut||3|doughnut
🥟|dumpling||3|dumpling
🥚|egg||3|egg
🍆|eggplant||3|eggplant
🧆|falafel||3|falafel
🍥|fish_cake||3|fish cake with swirl
🫓|flatbread||3|flatbread
🫕|fondue||3|fondue
🍴|fork_and_knife||3|fork and knife
🥠|fortune_cookie||3|fortune cookie
🍳|fried_egg||3|cooking
🍤|fried_shrimp||3|fried shrimp
🍟|fries||3|french fries
🧄|garlic||3|garlic
🫚|ginger_root||3|ginger root
🍇|grapes||3|grapes
🍏|green_apple||3|green apple
🥗|green_salad||3|green salad
🍔|hamburger||3|hamburger
🔪|hocho|knife|3|kitchen knife
🍯|honey_pot||3|honey pot
🌶️|hot_pepper||3|hot pepper
🌭|hotdog||3|hot dog
🍨|ice_cream||3|ice cream
🧊|ice_cube||3|ice
🍦|icecream||3|soft ice cream
🫙|jar||3|jar
🥝|kiwi_fruit||3|kiwi fruit
🥬|leafy_green||3|leafy green
🍋|lemon||3|lemon
🦞|lobster||3|lobster
🍭|lollipop||3|lollipop
🥭|mango||3|mango
🧉|mate||3|mate
🍖|meat_on_bone||3|meat on bone
🍈|melon||3|melon
🥛|milk_glass||3|glass of milk
🥮|moon_cake||3|moon cake
🍢|oden||3|oden
🫒|olive||3|olive
🧅|onion||3|onion
🦪|oyster||3|oyster
🥞|pancakes||3|pancakes
🫛|pea_pod||3|pea pod
🍑|peach||3|peach
🥜|peanuts||3|peanuts
🍐|pear||3|pear
🥧|pie||3|pie
🍍|pineapple||3|pineapple
🍕|pizza||3|pizza
🍽️|plate_with_cutlery||3|fork and knife with plate
🍿|popcorn||3|popcorn
🥔|potato||3|potato
🍗|poultry_leg||3|poultry leg
🫗|pouring_liquid||3|pouring liquid
🥨|pretzel||3|pretzel
🍜|ramen||3|steaming bowl
🍚|rice||3|cooked rice
🍙|rice_ball||3|rice ball
🍘|rice_cracker||3|rice cracker
🍶|sake||3|sake
🧂|salt||3|salt
🥪|sandwich||3|sandwich
🥘|shallow_pan_of_food||3|shallow pan of food
🍧|shaved_ice||3|shaved ice
🦐|shrimp||3|shrimp
🍝|spaghetti||3|spaghetti
🥄|spoon||3|spoon
🦑|squid||3|squid
🍲|stew||3|pot of food
🍓|strawberry||3|strawberry
🥙|stuffed_flatbread||3|stuffed flatbread
🍣|sushi||3|sushi
🍠|sweet_potato||3|roasted sweet potato
🌮|taco||3|taco
🥡|takeout_box||3|takeout box
🫔|tamale||3|tamale
🍊|tangerine|orange mandarin|3|tangerine
🍵|tea||3|teacup without handle
🫖|teapot||3|teapot
🍅|tomato||3|tomato
🍹|tropical_drink||3|tropical drink
🥃|tumbler_glass||3|tumbler glass
🧇|waffle||3|waffle
🍉|watermelon||3|watermelon
🍷|wine_glass||3|wine glass
🥇|1st_place_medal||4|1st place medal
🥈|2nd_place_medal||4|2nd place medal
🥉|3rd_place_medal||4|3rd place medal
🎱|8ball||4|pool 8 ball
🎨|art||4|artist palette
🏸|badminton||4|badminton
🎈|balloon||4|balloon
🎍|bamboo||4|pine decoration
⚾|baseball||4|baseball
🏀|basketball||4|basketball
🃏|black_joker||4|joker
🎳|bowling||4|bowling
🥊|boxing_glove||4|boxing glove
♟️|chess_pawn||4|chess pawn
🎄|christmas_tree||4|Christmas tree
♣️|clubs||4|club suit
🎊|confetti_ball||4|confetti ball
🏏|cricket_game||4|cricket game
🔮|crystal_ball||4|crystal ball
🥌|curling_stone||4|curling stone
🎯|dart||4|bullseye
♦️|diamonds||4|diamond suit
🤿|diving_mask||4|diving mask
🎎|dolls||4|Japanese dolls
🏑|field_hockey||4|field hockey
🧨|firecracker||4|firecracker
🎆|fireworks||4|fireworks
🎣|fishing_pole_and_fish||4|fishing pole
🎏|flags||4|carp streamer
🎴|flower_playing_cards||4|flower playing cards
🥏|flying_disc||4|flying disc
🏈|football||4|american football
🖼️|framed_picture||4|framed picture
🎲|game_die||4|game die
🎁|gift||4|wrapped gift
🥅|goal_net||4|goal net
⛳|golf||4|flag in hole
🔫|gun||4|water pistol
♥️|hearts||4|heart suit
🏒|ice_hockey||4|ice hockey
⛸️|ice_skate||4|ice skate
🎃|jack_o_lantern||4|jack-o-lantern
🧩|jigsaw||4|puzzle piece
🕹️|joystick||4|joystick
🪁|kite||4|kite
🪢|knot||4|knot
🥍|lacrosse||4|lacrosse
🪄|magic_wand||4|magic wand
🀄|mahjong||4|mahjong red dragon
🥋|martial_arts_uniform||4|martial arts uniform
🎖️|medal_military||4|military medal
🏅|medal_sports||4|sports medal
🪩|mirror_ball||4|mirror ball
🪆|nesting_dolls||4|nesting dolls
🎭|performing_arts||4|performing arts
🪅|pinata||4|piñata
🏓|ping_pong||4|ping pong
🧧|red_envelope||4|red envelope
🎗️|reminder_ribbon||4|reminder ribbon
🎀|ribbon||4|ribbon
🎑|rice_scene||4|moon viewing ceremony
🏉|rugby_football||4|rugby football
🎽|running_shirt_with_sash||4|running shirt
🪡|sewing_needle||4|sewing needle
🎿|ski||4|skis
🛷|sled||4|sled
🎰|slot_machine||4|slot machine
⚽|soccer||4|soccer ball
🥎|softball||4|softball
♠️|spades||4|spade suit
🎇|sparkler||4|sparkler
✨|sparkles||4|sparkles
🎉|tada||4|party popper
🎋|tanabata_tree||4|tanabata tree
🧸|teddy_bear||4|teddy bear
🎾|tennis||4|tennis
🧵|thread||4|thread
🎫|ticket||4|ticket
🎟️|tickets||4|admission tickets
🏆|trophy||4|trophy
🎮|video_game||4|video game
🏐|volleyball||4|volleyball
🎐|wind_chime||4|wind chime
🧶|yarn||4|yarn
🪀|yo_yo||4|yo-yo
🚡|aerial_tramway||5|aerial tramway
✈️|airplane||5|airplane
⏰|alarm_clock||5|alarm clock
🚑|ambulance||5|ambulance
⚓|anchor||5|anchor
🚛|articulated_lorry||5|articulated lorry
🛰️|artificial_satellite||5|satellite
🛺|auto_rickshaw||5|auto rickshaw
🏦|bank||5|bank
💈|barber||5|barber pole
🏖️|beach_umbrella||5|beach with umbrella
🛎️|bellhop_bell||5|bellhop bell
🚲|bike||5|bicycle
🚙|blue_car||5|sport utility vehicle
⛵|boat|sailboat|5|sailboat
🧱|bricks||5|brick
🌉|bridge_at_night||5|bridge at night
🏗️|building_construction||5|building construction
🚅|bullettrain_front||5|bullet train
🚄|bullettrain_side||5|high-speed train
🚌|bus||5|bus
🚏|busstop||5|bus stop
🏕️|camping||5|camping
🛶|canoe||5|canoe
🚗|car|red_car|5|automobile
🎠|carousel_horse||5|carousel horse
⛪|church||5|church
🎪|circus_tent||5|circus tent
🌇|city_sunrise||5|sunset
🌆|city_sunset||5|cityscape at dusk
🏙️|cityscape||5|cityscape
🏛️|classical_building||5|classical building
🕐|clock1||5|one o’clock
🕙|clock10||5|ten o’clock
🕥|clock1030||5|ten-thirty
🕚|clock11||5|eleven o’clock
🕦|clock1130||5|eleven-thirty
🕛|clock12||5|twelve o’clock
🕧|clock1230||5|twelve-thirty
🕜|clock130||5|one-thirty
🕑|clock2||5|two o’clock
🕝|clock230||5|two-thirty
🕒|clock3||5|three o’clock
🕞|clock330||5|three-thirty
🕓|clock4||5|four o’clock
🕟|clock430||5|four-thirty
🕔|clock5||5|five o’clock
🕠|clock530||5|five-thirty
🕕|clock6||5|six o’clock
🕡|clock630||5|six-thirty
🕖|clock7||5|seven o’clock
🕢|clock730||5|seven-thirty
🕗|clock8||5|eight o’clock
🕣|clock830||5|eight-thirty
🕘|clock9||5|nine o’clock
🕤|clock930||5|nine-thirty
🌂|closed_umbrella||5|closed umbrella
☁️|cloud||5|cloud
🌩️|cloud_with_lightning||5|cloud with lightning
⛈️|cloud_with_lightning_and_rain||5|cloud with lightning and rain
🌧️|cloud_with_rain||5|cloud with rain
🌨️|cloud_with_snow||5|cloud with snow
☄️|comet||5|comet
🧭|compass||5|compass
🚧|construction||5|construction
🏪|convenience_store||5|convenience store
🌙|crescent_moon||5|crescent moon
🌀|cyclone||5|cyclone
🏬|department_store||5|department store
🏚️|derelict_house||5|derelict house
🏜️|desert||5|desert
🏝️|desert_island||5|desert island
💧|droplet||5|droplet
🌍|earth_africa||5|globe showing Europe-Africa
🌎|earth_americas||5|globe showing Americas
🌏|earth_asia||5|globe showing Asia-Australia
🏰|european_castle||5|castle
🏤|european_post_office||5|post office
🏭|factory||5|factory
🎡|ferris_wheel||5|ferris wheel
⛴️|ferry||5|ferry
🔥|fire||5|fire
🚒|fire_engine||5|fire engine
🌓|first_quarter_moon||5|first quarter moon
🌛|first_quarter_moon_with_face||5|first quarter moon face
🛬|flight_arrival||5|airplane arrival
🛫|flight_departure||5|airplane departure
🛸|flying_saucer||5|flying saucer
🌫️|fog||5|fog
🌁|foggy||5|foggy
⛲|fountain||5|fountain
⛽|fuelpump||5|fuel pump
🌕|full_moon||5|full moon
🌝|full_moon_with_face||5|full moon face
🌐|globe_with_meridians||5|globe with meridians
🚁|helicopter||5|helicopter
🛕|hindu_temple||5|hindu temple
🏥|hospital||5|hospital
🏨|hotel||5|hotel
♨️|hotsprings||5|hot springs
⌛|hourglass||5|hourglass done
⏳|hourglass_flowing_sand||5|hourglass not done
🏠|house||5|house
🏡|house_with_garden||5|house with garden
🏘️|houses||5|houses
🛖|hut||5|hut
🗾|japan||5|map of Japan
🏯|japanese_castle||5|Japanese castle
🕋|kaaba||5|kaaba
🛴|kick_scooter||5|kick scooter
🌗|last_quarter_moon||5|last quarter moon
🌜|last_quarter_moon_with_face||5|last quarter moon face
🚈|light_rail||5|light rail
🏩|love_hotel||5|love hotel
🧳|luggage||5|luggage
🕰️|mantelpiece_clock||5|mantelpiece clock
🦽|manual_wheelchair||5|manual wheelchair
🚇|metro||5|metro
🌌|milky_way||5|milky way
🚐|minibus||5|minibus
🚝|monorail||5|monorail
🌔|moon|waxing_gibbous_moon|5|waxing gibbous moon
🕌|mosque||5|mosque
🛥️|motor_boat||5|motor boat
🛵|motor_scooter||5|motor scooter
🏍️|motorcycle||5|motorcycle
🦼|motorized_wheelchair||5|motorized wheelchair
🛣️|motorway||5|motorway
🗻|mount_fuji||5|mount fuji
⛰️|mountain||5|mountain
🚠|mountain_cableway||5|mountain cableway
🚞|mountain_railway||5|mountain railway
🏔️|mountain_snow||5|snow-capped mountain
🏞️|national_park||5|national park
🌑|new_moon||5|new moon
🌚|new_moon_with_face||5|new moon face
🌃|night_with_stars||5|night with stars
🌊|ocean||5|water wave
🏢|office||5|office building
🛢️|oil_drum||5|oil drum
🚘|oncoming_automobile||5|oncoming automobile
🚍|oncoming_bus||5|oncoming bus
🚔|oncoming_police_car||5|oncoming police car
🚖|oncoming_taxi||5|oncoming taxi
☂️|open_umbrella||5|umbrella
🪂|parachute||5|parachute
⛱️|parasol_on_ground||5|umbrella on ground
⛅|partly_sunny||5|sun behind cloud
🛳️|passenger_ship||5|passenger ship
🛻|pickup_truck||5|pickup truck
🛝|playground_slide||5|playground slide
🚓|police_car||5|police car
🏣|post_office||5|Japanese post office
🏎️|racing_car||5|racing car
🚃|railway_car||5|railway car
🛤️|railway_track||5|railway track
🌈|rainbow||5|rainbow
🛟|ring_buoy||5|ring buoy
🪐|ringed_planet||5|ringed planet
🪨|rock||5|rock
🚀|rocket||5|rocket
🎢|roller_coaster||5|roller coaster
🛼|roller_skate||5|roller skate
🚨|rotating_light||5|police car light
🏫|school||5|school
💺|seat||5|seat
⛩️|shinto_shrine||5|shinto shrine
🚢|ship||5|ship
🛹|skateboard||5|skateboard
🛩️|small_airplane||5|small airplane
❄️|snowflake||5|snowflake
⛄|snowman||5|snowman without snow
☃️|snowman_with_snow||5|snowman
🚤|speedboat||5|speedboat
🏟️|stadium||5|stadium
⭐|star||5|star
🌟|star2||5|glowing star
🌠|stars||5|shooting star
🚉|station||5|station
🗽|statue_of_liberty||5|Statue of Liberty
🚂|steam_locomotive||5|locomotive
🛑|stop_sign||5|stop sign
⏱️|stopwatch||5|stopwatch
🌥️|sun_behind_large_cloud||5|sun behind large cloud
🌦️|sun_behind_rain_cloud||5|sun behind rain cloud
🌤️|sun_behind_small_cloud||5|sun behind small cloud
🌞|sun_with_face||5|sun with face
☀️|sunny||5|sun
🌅|sunrise||5|sunrise
🌄|sunrise_over_mountains||5|sunrise over mountains
🚟|suspension_railway||5|suspension railway
🕍|synagogue||5|synagogue
🚕|taxi||5|taxi
⛺|tent||5|tent
🌡️|thermometer||5|thermometer
⏲️|timer_clock||5|timer clock
🗼|tokyo_tower||5|Tokyo tower
🌪️|tornado||5|tornado
🚜|tractor||5|tractor
🚥|traffic_light||5|horizontal traffic light
🚋|train||5|tram car
🚆|train2||5|train
🚊|tram||5|tram
🚎|trolleybus||5|trolleybus
🚚|truck||5|delivery truck
☔|umbrella||5|umbrella with rain drops
🚦|vertical_traffic_light||5|vertical traffic light
🌋|volcano||5|volcano
🌘|waning_crescent_moon||5|waning crescent moon
🌖|waning_gibbous_moon||5|waning gibbous moon
⌚|watch||5|watch
🌒|waxing_crescent_moon||5|waxing crescent moon
💒|wedding||5|wedding
🛞|wheel||5|wheel
🌬️|wind_face||5|wind face
🪵|wood||5|wood
🗺️|world_map||5|world map
⚡|zap||5|high voltage
🧮|abacus||6|abacus
🪗|accordion||6|accordion
🩹|adhesive_bandage||6|adhesive bandage
⚗️|alembic||6|alembic
👟|athletic_shoe||6|running shoe
🪓|axe||6|axe
⚖️|balance_scale||6|balance scale
🩰|ballet_shoes||6|ballet shoes
🗳️|ballot_box||6|ballot box with ballot
🪕|banjo||6|banjo
📊|bar_chart||6|bar chart
🧺|basket||6|basket
🛁|bathtub||6|bathtub
🔋|battery||6|battery
🛏️|bed||6|bed
🔔|bell||6|bell
👙|bikini||6|bikini
🧢|billed_cap||6|billed cap
✒️|black_nib||6|black nib
📘|blue_book||6|blue book
💣|bomb||6|bomb
📖|book|open_book|6|open book
🔖|bookmark||6|bookmark
📑|bookmark_tabs||6|bookmark tabs
📚|books||6|books
🪃|boomerang||6|boomerang
👢|boot||6|woman’s boot
🏹|bow_and_arrow||6|bow and arrow
💼|briefcase||6|briefcase
🧹|broom||6|broom
🫧|bubbles||6|bubbles
🪣|bucket||6|bucket
💡|bulb||6|light bulb
📆|calendar||6|tear-off calendar
📲|calling||6|mobile phone with arrow
📷|camera||6|camera
📸|camera_flash||6|camera with flash
🕯️|candle||6|candle
🗃️|card_file_box||6|card file box
📇|card_index||6|card index
🗂️|card_index_dividers||6|card index dividers
🪚|carpentry_saw||6|carpentry saw
💿|cd||6|optical disk
⛓️|chains||6|chains
🪑|chair||6|chair
💹|chart||6|chart increasing with yen
📉|chart_with_downwards_trend||6|chart decreasing
📈|chart_with_upwards_trend||6|chart increasing
🗜️|clamp||6|clamp
🎬|clapper||6|clapper board
📋|clipboard||6|clipboard
📕|closed_book||6|closed book
🔐|closed_lock_with_key||6|locked with key
🧥|coat||6|coat
⚰️|coffin||6|coffin
🪙|coin||6|coin
💻|computer||6|laptop
🖱️|computer_mouse||6|computer mouse
🎛️|control_knobs||6|control knobs
🛋️|couch_and_lamp||6|couch and lamp
🖍️|crayon||6|crayon
💳|credit_card||6|credit card
⚔️|crossed_swords||6|crossed swords
👑|crown||6|crown
🩼|crutch||6|crutch
🗡️|dagger||6|dagger
🕶️|dark_sunglasses||6|sunglasses
📅|date||6|calendar
🖥️|desktop_computer||6|desktop computer
🪔|diya_lamp||6|diya lamp
🧬|dna||6|dna
💵|dollar||6|dollar banknote
🚪|door||6|door
👗|dress||6|dress
🩸|drop_of_blood||6|drop of blood
🥁|drum||6|drum
📀|dvd||6|dvd
🔌|electric_plug||6|electric plug
🛗|elevator||6|elevator
📧|email|e-mail|6|e-mail
✉️|envelope||6|envelope
📩|envelope_with_arrow||6|envelope with arrow
💶|euro||6|euro banknote
👓|eyeglasses||6|glasses
📠|fax||6|fax machine
🗄️|file_cabinet||6|file cabinet
📁|file_folder||6|file folder
📽️|film_projector||6|film projector
🎞️|film_strip||6|film frames
🧯|fire_extinguisher||6|fire extinguisher
🔦|flashlight||6|flashlight
🥿|flat_shoe||6|flat shoe
💾|floppy_disk||6|floppy disk
🪈|flute||6|flute
🪭|folding_hand_fan||6|folding hand fan
🖋️|fountain_pen||6|fountain pen
⚱️|funeral_urn||6|funeral urn
⚙️|gear||6|gear
💎|gem||6|gem stone
🧤|gloves||6|gloves
🥽|goggles||6|goggles
📗|green_book||6|green book
🎸|guitar||6|guitar
🪮|hair_pick||6|hair pick
🔨|hammer||6|hammer
⚒️|hammer_and_pick||6|hammer and pick
🛠️|hammer_and_wrench||6|hammer and wrench
🪬|hamsa||6|hamsa
👜|handbag||6|handbag
🎧|headphones||6|headphone
🪦|headstone||6|headstone
👠|high_heel||6|high-heeled shoe
🥾|hiking_boot||6|hiking boot
🪝|hook||6|hook
🪪|identification_card||6|identification card
📥|inbox_tray||6|inbox tray
📨|incoming_envelope||6|incoming envelope
📱|iphone||6|mobile phone
🏮|izakaya_lantern|lantern|6|red paper lantern
👖|jeans||6|jeans
🔑|key||6|key
⌨️|keyboard||6|keyboard
👘|kimono||6|kimono
🥼|lab_coat||6|lab coat
🏷️|label||6|label
🪜|ladder||6|ladder
📒|ledger||6|ledger
🎚️|level_slider||6|level slider
🔗|link||6|link
💄|lipstick||6|lipstick
🔒|lock||6|locked
🔏|lock_with_ink_pen||6|locked with pen
🪘|long_drum||6|long drum
🧴|lotion_bottle||6|lotion bottle
🔊|loud_sound||6|speaker high volume
📢|loudspeaker||6|loudspeaker
🪫|low_battery||6|low battery
🔍|mag||6|magnifying glass tilted left
🔎|mag_right||6|magnifying glass tilted right
🧲|magnet||6|magnet
📫|mailbox||6|closed mailbox with raised flag
📪|mailbox_closed||6|closed mailbox with lowered flag
📬|mailbox_with_mail||6|open mailbox with raised flag
📭|mailbox_with_no_mail||6|open mailbox with lowered flag
👞|mans_shoe|shoe|6|man’s shoe
🪇|maracas||6|maracas
📣|mega||6|megaphone
📝|memo|pencil|6|memo
🎤|microphone||6|microphone
🔬|microscope||6|microscope
🪖|military_helmet||6|military helmet
💽|minidisc||6|computer disk
🪞|mirror||6|mirror
💸|money_with_wings||6|money with wings
💰|moneybag||6|money bag
🎓|mortar_board||6|graduation cap
🪤|mouse_trap||6|mouse trap
🎥|movie_camera||6|movie camera
🗿|moyai||6|moai
🎹|musical_keyboard||6|musical keyboard
🎵|musical_note||6|musical note
🎼|musical_score||6|musical score
🔇|mute||6|muted speaker
🧿|nazar_amulet||6|nazar amulet
👔|necktie||6|necktie
📰|newspaper||6|newspaper
🗞️|newspaper_roll||6|rolled-up newspaper
🔕|no_bell||6|bell with slash
📓|notebook||6|notebook
📔|notebook_with_decorative_cover||6|notebook with decorative cover
🎶|notes||6|musical notes
🔩|nut_and_bolt||6|nut and bolt
🗝️|old_key||6|old key
🩱|one_piece_swimsuit||6|one-piece swimsuit
📂|open_file_folder||6|open file folder
📙|orange_book||6|orange book
📤|outbox_tray||6|outbox tray
📦|package||6|package
📄|page_facing_up||6|page facing up
📃|page_with_curl||6|page with curl
📟|pager||6|pager
🖌️|paintbrush||6|paintbrush
📎|paperclip||6|paperclip
🖇️|paperclips||6|linked paperclips
🖊️|pen||6|pen
✏️|pencil2||6|pencil
🧫|petri_dish||6|petri dish
☎️|phone|telephone|6|telephone
⛏️|pick||6|pick
💊|pill||6|pill
🪧|placard||6|placard
🪠|plunger||6|plunger
📯|postal_horn||6|postal horn
📮|postbox||6|postbox
👝|pouch||6|clutch bag
💷|pound||6|pound banknote
📿|prayer_beads||6|prayer beads
🖨️|printer||6|printer
🦯|probing_cane||6|white cane
👛|purse||6|purse
📌|pushpin||6|pushpin
📻|radio||6|radio
🪒|razor||6|razor
🧾|receipt||6|receipt
⛑️|rescue_worker_helmet||6|rescue worker’s helmet
💍|ring||6|ring
🧻|roll_of_paper||6|roll of paper
📍|round_pushpin||6|round pushpin
🧷|safety_pin||6|safety pin
🦺|safety_vest||6|safety vest
👡|sandal||6|woman’s sandal
🥻|sari||6|sari
📡|satellite||6|satellite antenna
🎷|saxophone||6|saxophone
🧣|scarf||6|scarf
🎒|school_satchel||6|backpack
✂️|scissors||6|scissors
🪛|screwdriver||6|screwdriver
📜|scroll||6|scroll
🛡️|shield||6|shield
👕|shirt|tshirt|6|t-shirt
🛍️|shopping||6|shopping bags
🛒|shopping_cart||6|shopping cart
🩳|shorts||6|shorts
🚿|shower||6|shower
🚬|smoking||6|cigarette
🧼|soap||6|soap
🧦|socks||6|socks
🔉|sound||6|speaker medium volume
🔈|speaker||6|speaker low volume
🗓️|spiral_calendar||6|spiral calendar
🗒️|spiral_notepad||6|spiral notepad
🧽|sponge||6|sponge
🩺|stethoscope||6|stethoscope
📏|straight_ruler||6|straight ruler
🎙️|studio_microphone||6|studio microphone
🩲|swim_brief||6|briefs
💉|syringe||6|syringe
📞|telephone_receiver||6|telephone receiver
🔭|telescope||6|telescope
🧪|test_tube||6|test tube
🩴|thong_sandal||6|thong sandal
🚽|toilet||6|toilet
🧰|toolbox||6|toolbox
🪥|toothbrush||6|toothbrush
🎩|tophat||6|top hat
🖲️|trackball||6|trackball
📐|triangular_ruler||6|triangular ruler
🎺|trumpet||6|trumpet
📺|tv||6|television
🔓|unlock||6|unlocked
📼|vhs||6|videocassette
📹|video_camera||6|video camera
🎻|violin||6|violin
🗑️|wastebasket||6|wastebasket
🪟|window||6|window
👚|womans_clothes||6|woman’s clothes
👒|womans_hat||6|woman’s hat
🔧|wrench||6|wrench
🩻|x_ray||6|x-ray
💴|yen||6|yen banknote
🔢|1234||7|input numbers
🅰️|a||7|A button (blood type)
🆎|ab||7|AB button (blood type)
🔤|abc||7|input latin letters
🔡|abcd||7|input latin lowercase
🉑|accept||7|Japanese “acceptable” button
♒|aquarius||7|Aquarius
♈|aries||7|Aries
◀️|arrow_backward||7|reverse button
⏬|arrow_double_down||7|fast down button
⏫|arrow_double_up||7|fast up button
⬇️|arrow_down||7|down arrow
🔽|arrow_down_small||7|downwards button
▶️|arrow_forward||7|play button
⤵️|arrow_heading_down||7|right arrow curving down
⤴️|arrow_heading_up||7|right arrow curving up
⬅️|arrow_left||7|left arrow
↙️|arrow_lower_left||7|down-left arrow
↘️|arrow_lower_right||7|down-right arrow
➡️|arrow_right||7|right arrow
↪️|arrow_right_hook||7|left arrow curving right
⬆️|arrow_up||7|up arrow
↕️|arrow_up_down||7|up-down arrow
🔼|arrow_up_small||7|upwards button
↖️|arrow_upper_left||7|up-left arrow
↗️|arrow_upper_right||7|up-right arrow
🔃|arrows_clockwise||7|clockwise vertical arrows
🔄|arrows_counterclockwise||7|counterclockwise arrows button
*️⃣|asterisk||7|keycap: *
🏧|atm||7|ATM sign
⚛️|atom_symbol||7|atom symbol
🅱️|b||7|B button (blood type)
🚼|baby_symbol||7|baby symbol
🔙|back||7|BACK arrow
🛄|baggage_claim||7|baggage claim
☑️|ballot_box_with_check||7|check box with check
‼️|bangbang||7|double exclamation mark
🔰|beginner||7|Japanese symbol for beginner
☣️|biohazard||7|biohazard
⚫|black_circle||7|black circle
⬛|black_large_square||7|black large square
◾|black_medium_small_square||7|black medium-small square
◼️|black_medium_square||7|black medium square
▪️|black_small_square||7|black small square
🔲|black_square_button||7|black square button
🟦|blue_square||7|blue square
🟤|brown_circle||7|brown circle
🟫|brown_square||7|brown square
♋|cancer||7|Cancer
🔠|capital_abcd||7|input latin uppercase
♑|capricorn||7|Capricorn
🚸|children_crossing||7|children crossing
🎦|cinema||7|cinema
🆑|cl||7|CL button
㊗️|congratulations||7|Japanese “congratulations” button
🆒|cool||7|COOL button
©️|copyright||7|copyright
➰|curly_loop||7|curly loop
💱|currency_exchange||7|currency exchange
🛃|customs||7|customs
💠|diamond_shape_with_a_dot_inside||7|diamond with a dot
🚯|do_not_litter||7|no littering
8️⃣|eight||7|keycap: 8
✴️|eight_pointed_black_star||7|eight-pointed star
✳️|eight_spoked_asterisk||7|eight-spoked asterisk
⏏️|eject_button||7|eject button
🔚|end||7|END arrow
❗|exclamation|heavy_exclamation_mark|7|red exclamation mark
⏩|fast_forward||7|fast-forward button
♀️|female_sign||7|female sign
5️⃣|five||7|keycap: 5
⚜️|fleur_de_lis||7|fleur-de-lis
4️⃣|four||7|keycap: 4
🆓|free||7|FREE button
♊|gemini||7|Gemini
🟢|green_circle||7|green circle
🟩|green_square||7|green square
❕|grey_exclamation||7|white exclamation mark
❔|grey_question||7|white question mark
#️⃣|hash||7|keycap: #
✔️|heavy_check_mark||7|check mark
➗|heavy_division_sign||7|divide
💲|heavy_dollar_sign||7|heavy dollar sign
🟰|heavy_equals_sign||7|heavy equals sign
➖|heavy_minus_sign||7|minus
✖️|heavy_multiplication_x||7|multiply
➕|heavy_plus_sign||7|plus
🔆|high_brightness||7|bright button
🆔|id||7|ID button
🉐|ideograph_advantage||7|Japanese “bargain” button
♾️|infinity||7|infinity
ℹ️|information_source||7|information
⁉️|interrobang||7|exclamation question mark
🔟|keycap_ten||7|keycap: 10
🪯|khanda||7|khanda
🈁|koko||7|Japanese “here” button
🔵|large_blue_circle||7|blue circle
🔷|large_blue_diamond||7|large blue diamond
🔶|large_orange_diamond||7|large orange diamond
✝️|latin_cross||7|latin cross
🛅|left_luggage||7|left luggage
↔️|left_right_arrow||7|left-right arrow
↩️|leftwards_arrow_with_hook||7|right arrow curving left
♌|leo||7|Leo
♎|libra||7|Libra
➿|loop||7|double curly loop
🔅|low_brightness||7|dim button
Ⓜ️|m||7|circled M
♂️|male_sign||7|male sign
⚕️|medical_symbol||7|medical symbol
🕎|menorah||7|menorah
🚹|mens||7|men’s room
📴|mobile_phone_off||7|mobile phone off
📛|name_badge||7|name badge
❎|negative_squared_cross_mark||7|cross mark button
🆕|new||7|NEW button
⏭️|next_track_button||7|next track button
🆖|ng||7|NG button
9️⃣|nine||7|keycap: 9
🚳|no_bicycles||7|no bicycles
⛔|no_entry||7|no entry
🚫|no_entry_sign||7|prohibited
📵|no_mobile_phones||7|no mobile phones
🚷|no_pedestrians||7|no pedestrians
🚭|no_smoking||7|no smoking
🚱|non-potable_water||7|non-potable water
⭕|o||7|hollow red circle
🅾️|o2||7|O button (blood type)
🆗|ok||7|OK button
🕉️|om||7|om
🔛|on||7|ON! arrow
1️⃣|one||7|keycap: 1
⛎|ophiuchus||7|Ophiuchus
🟠|orange_circle||7|orange circle
🟧|orange_square||7|orange square
☦️|orthodox_cross||7|orthodox cross
🅿️|parking||7|P button
〽️|part_alternation_mark||7|part alternation mark
🛂|passport_control||7|passport control
⏸️|pause_button||7|pause button
☮️|peace_symbol||7|peace symbol
♓|pisces||7|Pisces
🛐|place_of_worship||7|place of worship
⏯️|play_or_pause_button||7|play or pause button
🚰|potable_water||7|potable water
⏮️|previous_track_button||7|last track button
🟣|purple_circle||7|purple circle
🟪|purple_square||7|purple square
🚮|put_litter_in_its_place||7|litter in bin sign
❓|question||7|red question mark
🔘|radio_button||7|radio button
☢️|radioactive||7|radioactive
⏺️|record_button||7|record button
♻️|recycle||7|recycling symbol
🔴|red_circle||7|red circle
🟥|red_square||7|red square
®️|registered||7|registered
🔁|repeat||7|repeat button
🔂|repeat_one||7|repeat single button
🚻|restroom||7|restroom
⏪|rewind||7|fast reverse button
🈂️|sa||7|Japanese “service charge” button
♐|sagittarius||7|Sagittarius
♏|scorpius||7|Scorpio
㊙️|secret||7|Japanese “secret” button
7️⃣|seven||7|keycap: 7
📶|signal_strength||7|antenna bars
6️⃣|six||7|keycap: 6
🔯|six_pointed_star||7|dotted six-pointed star
🔹|small_blue_diamond||7|small blue diamond
🔸|small_orange_diamond||7|small orange diamond
🔺|small_red_triangle||7|red triangle pointed up
🔻|small_red_triangle_down||7|red triangle pointed down
🔜|soon||7|SOON arrow
🆘|sos||7|SOS button
❇️|sparkle||7|sparkle
☪️|star_and_crescent||7|star and crescent
✡️|star_of_david||7|star of David
⏹️|stop_button||7|stop button
🔣|symbols||7|input symbols
♉|taurus||7|Taurus
3️⃣|three||7|keycap: 3
™️|tm||7|trade mark
🔝|top||7|TOP arrow
⚧️|transgender_symbol||7|transgender symbol
🔱|trident||7|trident emblem
🔀|twisted_rightwards_arrows||7|shuffle tracks button
2️⃣|two||7|keycap: 2
🈹|u5272||7|Japanese “discount” button
🈴|u5408||7|Japanese “passing grade” button
🈺|u55b6||7|Japanese “open for business” button
🈯|u6307||7|Japanese “reserved” button
🈷️|u6708||7|Japanese “monthly amount” button
🈶|u6709||7|Japanese “not free of charge” button
🈵|u6e80||7|Japanese “no vacancy” button
🈚|u7121||7|Japanese “free of charge” button
🈸|u7533||7|Japanese “application” button
🈲|u7981||7|Japanese “prohibited” button
🈳|u7a7a||7|Japanese “vacancy” button
🔞|underage||7|no one under eighteen
🆙|up||7|UP! button
📳|vibration_mode||7|vibration mode
♍|virgo||7|Virgo
🆚|vs||7|VS button
⚠️|warning||7|warning
〰️|wavy_dash||7|wavy dash
🚾|wc||7|water closet
☸️|wheel_of_dharma||7|wheel of dharma
♿|wheelchair||7|wheelchair symbol
✅|white_check_mark||7|check mark button
⚪|white_circle||7|white circle
⬜|white_large_square||7|white large square
◽|white_medium_small_square||7|white medium-small square
◻️|white_medium_square||7|white medium square
▫️|white_small_square||7|white small square
🔳|white_square_button||7|white square button
🛜|wireless||7|wireless
🚺|womens||7|women’s room
❌|x||7|cross mark
🟡|yellow_circle||7|yellow circle
🟨|yellow_square||7|yellow square
☯️|yin_yang||7|yin yang
0️⃣|zero||7|keycap: 0
🇦🇫|afghanistan||8|flag: Afghanistan
🇦🇽|aland_islands||8|flag: Åland Islands
🇦🇱|albania||8|flag: Albania
🇩🇿|algeria||8|flag: Algeria
🇦🇸|american_samoa||8|flag: American Samoa
🇦🇩|andorra||8|flag: Andorra
🇦🇴|angola||8|flag: Angola
🇦🇮|anguilla||8|flag: Anguilla
🇦🇶|antarctica||8|flag: Antarctica
🇦🇬|antigua_barbuda||8|flag: Antigua & Barbuda
🇦🇷|argentina||8|flag: Argentina
🇦🇲|armenia||8|flag: Armenia
🇦🇼|aruba||8|flag: Aruba
🇦🇨|ascension_island||8|flag: Ascension Island
🇦🇺|australia||8|flag: Australia
🇦🇹|austria||8|flag: Austria
🇦🇿|azerbaijan||8|flag: Azerbaijan
🇧🇸|bahamas||8|flag: Bahamas
🇧🇭|bahrain||8|flag: Bahrain
🇧🇩|bangladesh||8|flag: Bangladesh
🇧🇧|barbados||8|flag: Barbados
🇧🇾|belarus||8|flag: Belarus
🇧🇪|belgium||8|flag: Belgium
🇧🇿|belize||8|flag: Belize
🇧🇯|benin||8|flag: Benin
🇧🇲|bermuda||8|flag: Bermuda
🇧🇹|bhutan||8|flag: Bhutan
🏴|black_flag||8|black flag
🇧🇴|bolivia||8|flag: Bolivia
🇧🇦|bosnia_herzegovina||8|flag: Bosnia & Herzegovina
🇧🇼|botswana||8|flag: Botswana
🇧🇻|bouvet_island||8|flag: Bouvet Island
🇧🇷|brazil||8|flag: Brazil
🇮🇴|british_indian_ocean_territory||8|flag: British Indian Ocean Territory
🇻🇬|british_virgin_islands||8|flag: British Virgin Islands
🇧🇳|brunei||8|flag: Brunei
🇧🇬|bulgaria||8|flag: Bulgaria
🇧🇫|burkina_faso||8|flag: Burkina Faso
🇧🇮|burundi||8|flag: Burundi
🇰🇭|cambodia||8|flag: Cambodia
🇨🇲|cameroon||8|flag: Cameroon
🇨🇦|canada||8|flag: Canada
🇮🇨|canary_islands||8|flag: Canary Islands
🇨🇻|cape_verde||8|flag: Cape Verde
🇧🇶|caribbean_netherlands||8|flag: Caribbean Netherlands
🇰🇾|cayman_islands||8|flag: Cayman Islands
🇨🇫|central_african_republic||8|flag: Central African Republic
🇪🇦|ceuta_melilla||8|flag: Ceuta & Melilla
🇹🇩|chad||8|flag: Chad
🏁|checkered_flag||8|chequered flag
🇨🇱|chile||8|flag: Chile
🇨🇽|christmas_island||8|flag: Christmas Island
🇨🇵|clipperton_island||8|flag: Clipperton Island
🇨🇳|cn||8|flag: China
🇨🇨|cocos_islands||8|flag: Cocos (Keeling) Islands
🇨🇴|colombia||8|flag: Colombia
🇰🇲|comoros||8|flag: Comoros
🇨🇬|congo_brazzaville||8|flag: Congo - Brazzaville
🇨🇩|congo_kinshasa||8|flag: Congo - Kinshasa
🇨🇰|cook_islands||8|flag: Cook Islands
🇨🇷|costa_rica||8|flag: Costa Rica
🇨🇮|cote_divoire||8|flag: Côte d’Ivoire
🇭🇷|croatia||8|flag: Croatia
🎌|crossed_flags||8|crossed flags
🇨🇺|cuba||8|flag: Cuba
🇨🇼|curacao||8|flag: Curaçao
🇨🇾|cyprus||8|flag: Cyprus
🇨🇿|czech_republic||8|flag: Czechia
🇩🇪|de||8|flag: Germany
🇩🇰|denmark||8|flag: Denmark
🇩🇬|diego_garcia||8|flag: Diego Garcia
🇩🇯|djibouti||8|flag: Djibouti
🇩🇲|dominica||8|flag: Dominica
🇩🇴|dominican_republic||8|flag: Dominican Republic
🇪🇨|ecuador||8|flag: Ecuador
🇪🇬|egypt||8|flag: Egypt
🇸🇻|el_salvador||8|flag: El Salvador
🏴󠁧󠁢󠁥󠁮󠁧󠁿|england||8|flag: England
🇬🇶|equatorial_guinea||8|flag: Equatorial Guinea
🇪🇷|eritrea||8|flag: Eritrea
🇪🇸|es||8|flag: Spain
🇪🇪|estonia||8|flag: Estonia
🇪🇹|ethiopia||8|flag: Ethiopia
🇪🇺|eu|european_union|8|flag: European Union
🇫🇰|falkland_islands||8|flag: Falkland Islands
🇫🇴|faroe_islands||8|flag: Faroe Islands
🇫🇯|fiji||8|flag: Fiji
🇫🇮|finland||8|flag: Finland
🇫🇷|fr||8|flag: France
🇬🇫|french_guiana||8|flag: French Guiana
🇵🇫|french_polynesia||8|flag: French Polynesia
🇹🇫|french_southern_territories||8|flag: French Southern Territories
🇬🇦|gabon||8|flag: Gabon
🇬🇲|gambia||8|flag: Gambia
🇬🇧|gb|uk|8|flag: United Kingdom
🇬🇪|georgia||8|flag: Georgia
🇬🇭|ghana||8|flag: Ghana
🇬🇮|gibraltar||8|flag: Gibraltar
🇬🇷|greece||8|flag: Greece
🇬🇱|greenland||8|flag: Greenland
🇬🇩|grenada||8|flag: Grenada
🇬🇵|guadeloupe||8|flag: Guadeloupe
🇬🇺|guam||8|flag: Guam
🇬🇹|guatemala||8|flag: Guatemala
🇬🇬|guernsey||8|flag: Guernsey
🇬🇳|guinea||8|flag: Guinea
🇬🇼|guinea_bissau||8|flag: Guinea-Bissau
🇬🇾|guyana||8|flag: Guyana
🇭🇹|haiti||8|flag: Haiti
🇭🇲|heard_mcdonald_islands||8|flag: Heard & McDonald Islands
🇭🇳|honduras||8|flag: Honduras
🇭🇰|hong_kong||8|flag: Hong Kong SAR China
🇭🇺|hungary||8|flag: Hungary
🇮🇸|iceland||8|flag: Iceland
🇮🇳|india||8|flag: India
🇮🇩|indonesia||8|flag: Indonesia
🇮🇷|iran||8|flag: Iran
🇮🇶|iraq||8|flag: Iraq
🇮🇪|ireland||8|flag: Ireland
🇮🇲|isle_of_man||8|flag: Isle of Man
🇮🇱|israel||8|flag: Israel
🇮🇹|it||8|flag: Italy
🇯🇲|jamaica||8|flag: Jamaica
🇯🇪|jersey||8|flag: Jersey
🇯🇴|jordan||8|flag: Jordan
🇯🇵|jp||8|flag: Japan
🇰🇿|kazakhstan||8|flag: Kazakhstan
🇰🇪|kenya||8|flag: Kenya
🇰🇮|kiribati||8|flag: Kiribati
🇽🇰|kosovo||8|flag: Kosovo
🇰🇷|kr||8|flag: South Korea
🇰🇼|kuwait||8|flag: Kuwait
🇰🇬|kyrgyzstan||8|flag: Kyrgyzstan
🇱🇦|laos||8|flag: Laos
🇱🇻|latvia||8|flag: Latvia
🇱🇧|lebanon||8|flag: Lebanon
🇱🇸|lesotho||8|flag: Lesotho
🇱🇷|liberia||8|flag: Liberia
🇱🇾|libya||8|flag: Libya
🇱🇮|liechtenstein||8|flag: Liechtenstein
🇱🇹|lithuania||8|flag: Lithuania
🇱🇺|luxembourg||8|flag: Luxembourg
🇲🇴|macau||8|flag: Macao SAR China
🇲🇰|macedonia||8|flag: North Macedonia
🇲🇬|madagascar||8|flag: Madagascar
🇲🇼|malawi||8|flag: Malawi
🇲🇾|malaysia||8|flag: Malaysia
🇲🇻|maldives||8|flag: Maldives
🇲🇱|mali||8|flag: Mali
🇲🇹|malta||8|flag: Malta
🇲🇭|marshall_islands||8|flag: Marshall Islands
🇲🇶|martinique||8|flag: Martinique
🇲🇷|mauritania||8|flag: Mauritania
🇲🇺|mauritius||8|flag: Mauritius
🇾🇹|mayotte||8|flag: Mayotte
🇲🇽|mexico||8|flag: Mexico
🇫🇲|micronesia||8|flag: Micronesia
🇲🇩|moldova||8|flag: Moldova
🇲🇨|monaco||8|flag: Monaco
🇲🇳|mongolia||8|flag: Mongolia
🇲🇪|montenegro||8|flag: Montenegro
🇲🇸|montserrat||8|flag: Montserrat
🇲🇦|morocco||8|flag: Morocco
🇲🇿|mozambique||8|flag: Mozambique
🇲🇲|myanmar||8|flag: Myanmar (Burma)
🇳🇦|namibia||8|flag: Namibia
🇳🇷|nauru||8|flag: Nauru
🇳🇵|nepal||8|flag: Nepal
🇳🇱|netherlands||8|flag: Netherlands
🇳🇨|new_caledonia||8|flag: New Caledonia
🇳🇿|new_zealand||8|flag: New Zealand
🇳🇮|nicaragua||8|flag: Nicaragua
🇳🇪|niger||8|flag: Niger
🇳🇬|nigeria||8|flag: Nigeria
🇳🇺|niue||8|flag: Niue
🇳🇫|norfolk_island||8|flag: Norfolk Island
🇰🇵|north_korea||8|flag: North Korea
🇲🇵|northern_mariana_islands||8|flag: Northern Mariana Islands
🇳🇴|norway||8|flag: Norway
🇴🇲|oman||8|flag: Oman
🇵🇰|pakistan||8|flag: Pakistan
🇵🇼|palau||8|flag: Palau
🇵🇸|palestinian_territories||8|flag: Palestinian Territories
🇵🇦|panama||8|flag: Panama
🇵🇬|papua_new_guinea||8|flag: Papua New Guinea
🇵🇾|paraguay||8|flag: Paraguay
🇵🇪|peru||8|flag: Peru
🇵🇭|philippines||8|flag: Philippines
🏴‍☠️|pirate_flag||8|pirate flag
🇵🇳|pitcairn_islands||8|flag: Pitcairn Islands
🇵🇱|poland||8|flag: Poland
🇵🇹|portugal||8|flag: Portugal
🇵🇷|puerto_rico||8|flag: Puerto Rico
🇶🇦|qatar||8|flag: Qatar
🏳️‍🌈|rainbow_flag||8|rainbow flag
🇷🇪|reunion||8|flag: Réunion
🇷🇴|romania||8|flag: Romania
🇷🇺|ru||8|flag: Russia
🇷🇼|rwanda||8|flag: Rwanda
🇼🇸|samoa||8|flag: Samoa
🇸🇲|san_marino||8|flag: San Marino
🇸🇹|sao_tome_principe||8|flag: São Tomé & Príncipe
🇸🇦|saudi_arabia||8|flag: Saudi Arabia
🏴󠁧󠁢󠁳󠁣󠁴󠁿|scotland||8|flag: Scotland
🇸🇳|senegal||8|flag: Senegal
🇷🇸|serbia||8|flag: Serbia
🇸🇨|seychelles||8|flag: Seychelles
🇸🇱|sierra_leone||8|flag: Sierra Leone
🇸🇬|singapore||8|flag: Singapore
🇸🇽|sint_maarten||8|flag: Sint Maarten
🇸🇰|slovakia||8|flag: Slovakia
🇸🇮|slovenia||8|flag: Slovenia
🇸🇧|solomon_islands||8|flag: Solomon Islands
🇸🇴|somalia||8|flag: Somalia
🇿🇦|south_africa||8|flag: South Africa
🇬🇸|south_georgia_south_sandwich_islands||8|flag: South Georgia & South Sandwich Islands
🇸🇸|south_sudan||8|flag: South Sudan
🇱🇰|sri_lanka||8|flag: Sri Lanka
🇧🇱|st_barthelemy||8|flag: St. Barthélemy
🇸🇭|st_helena||8|flag: St. Helena
🇰🇳|st_kitts_nevis||8|flag: St. Kitts & Nevis
🇱🇨|st_lucia||8|flag: St. Lucia
🇲🇫|st_martin||8|flag: St. Martin
🇵🇲|st_pierre_miquelon||8|flag: St. Pierre & Miquelon
🇻🇨|st_vincent_grenadines||8|flag: St. Vincent & Grenadines
🇸🇩|sudan||8|flag: Sudan
🇸🇷|suriname||8|flag: Suriname
🇸🇯|svalbard_jan_mayen||8|flag: Svalbard & Jan Mayen
🇸🇿|swaziland||8|flag: Eswatini
🇸🇪|sweden||8|flag: Sweden
🇨🇭|switzerland||8|flag: Switzerland
🇸🇾|syria||8|flag: Syria
🇹🇼|taiwan||8|flag: Taiwan
🇹🇯|tajikistan||8|flag: Tajikistan
🇹🇿|tanzania||8|flag: Tanzania
🇹🇭|thailand||8|flag: Thailand
🇹🇱|timor_leste||8|flag: Timor-Leste
🇹🇬|togo||8|flag: Togo
🇹🇰|tokelau||8|flag: Tokelau
🇹🇴|tonga||8|flag: Tonga
🇹🇷|tr||8|flag: Turkey
🏳️‍⚧️|transgender_flag||8|transgender flag
🚩|triangular_flag_on_post||8|triangular flag
🇹🇹|trinidad_tobago||8|flag: Trinidad & Tobago
🇹🇦|tristan_da_cunha||8|flag: Tristan da Cunha
🇹🇳|tunisia||8|flag: Tunisia
🇹🇲|turkmenistan||8|flag: Turkmenistan
🇹🇨|turks_caicos_islands||8|flag: Turks & Caicos Islands
🇹🇻|tuvalu||8|flag: Tuvalu
🇺🇬|uganda||8|flag: Uganda
🇺🇦|ukraine||8|flag: Ukraine
🇦🇪|united_arab_emirates||8|flag: United Arab Emirates
🇺🇳|united_nations||8|flag: United Nations
🇺🇾|uruguay||8|flag: Uruguay
🇺🇸|us||8|flag: United States
🇺🇲|us_outlying_islands||8|flag: U.S. Outlying Islands
🇻🇮|us_virgin_islands||8|flag: U.S. Virgin Islands
🇺🇿|uzbekistan||8|flag: Uzbekistan
🇻🇺|vanuatu||8|flag: Vanuatu
🇻🇦|vatican_city||8|flag: Vatican City
🇻🇪|venezuela||8|flag: Venezuela
🇻🇳|vietnam||8|flag: Vietnam
🏴󠁧󠁢󠁷󠁬󠁳󠁿|wales||8|flag: Wales
🇼🇫|wallis_futuna||8|flag: Wallis & Futuna
🇪🇭|western_sahara||8|flag: Western Sahara
🏳️|white_flag||8|white flag
🇾🇪|yemen||8|flag: Yemen
🇿🇲|zambia||8|flag: Zambia
🇿🇼|zimbabwe||8|flag: Zimbabwe
`.trim();

// rowIndex|original search text (rows whose search text is not exactly
// "description primary extras")
const SEARCH_OVERRIDES = `
0|hundred points score perfect 100
1|alien ufo alien
2|anger symbol angry anger
3|angry face mad annoyed angry
4|anguished face stunned anguished
5|astonished face amazed gasp astonished
8|smiling face with smiling eyes proud blush
9|collision explode boom collision
13|cold face freezing ice cold_face
14|anxious face with sweat nervous cold_sweat
18|crying face sad tear cry
19|crying cat sad tear crying_cat_face
20|heart with arrow love heart cupid
21|face with symbols on mouth foul cursing_face
22|dashing away wind blow fast dash
23|disappointed face sad disappointed
24|sad but relieved face phew sweat nervous disappointed_relieved
26|dizzy star dizzy
28|dotted line face invisible dotted_line_face
30|exploding head mind blown exploding_head
34|face holding back tears tears gratitude face_holding_back_tears
36|face with diagonal mouth confused face_with_diagonal_mouth
37|face with head-bandage hurt face_with_head_bandage
38|face with open eyes and hand over mouth gasp shock face_with_open_eyes_and_hand_over_mouth
41|face with thermometer sick face_with_thermometer
42|fearful face scared shocked oops fearful
46|ghost halloween ghost
47|heart with ribbon chocolates gift_heart
52|grinning face smile happy grinning
53|face with hand over mouth quiet whoops hand_over_mouth
54|pile of poo crap hankey poop shit
55|hear-no-evil monkey monkey deaf hear_no_evil
56|red heart love heart
58|smiling face with heart-eyes love crush heart_eyes
65|hot face heat sweating hot_face
67|hushed face silence speechless hushed
68|angry face with horns angry devil evil horns imp
69|smiling face with halo angel innocent
71|ogre monster japanese_ogre
72|face with tears of joy tears joy
74|kiss mark lipstick kiss
78|face blowing a kiss flirt kissing_heart
80|grinning squinting face happy haha laughing satisfied
83|love letter email envelope love_letter
84|lying face liar lying_face
85|face with medical mask sick ill mask
86|melting face sarcasm dread melting_face
88|money-mouth face rich money_mouth_face
90|nauseated face sick barf disgusted nauseated_face
91|nerd face geek glasses nerd_face
92|neutral face meh neutral_face
93|face without mouth mute silence no_mouth
94|face with open mouth surprise impressed wow open_mouth
96|partying face celebration birthday partying_face
98|persevering face struggling persevere
100|pleading face puppy eyes pleading_face
103|enraged face angry rage pout
104|face with raised eyebrow suspicious raised_eyebrow
105|smiling face blush pleased relaxed
106|relieved face whew relieved
110|rolling on the floor laughing lol laughing rofl
112|saluting face respect saluting_face
113|face screaming in fear horror shocked scream
114|weary cat horror scream_cat
115|see-no-evil monkey monkey blind ignore see_no_evil
116|shaking face shock shaking_face
117|shushing face silence quiet shushing_face
118|skull dead danger poison skull
119|skull and crossbones danger pirate skull_and_crossbones
120|sleeping face zzz sleeping
121|sleepy face tired sleepy
124|grinning face with smiling eyes happy joy laugh pleased smile
126|grinning face with big eyes happy joy haha smiley
129|smiling face with hearts love smiling_face_with_three_hearts
130|smiling face with horns devil evil horns smiling_imp
131|smirking face smug smirk
133|sneezing face achoo sick sneezing_face
134|loudly crying face sad cry bawling sob
135|alien monster game retro space_invader
137|speak-no-evil monkey monkey mute hush speak_no_evil
138|speech balloon comment speech_balloon
139|star-struck eyes star_struck
141|squinting face with tongue prank stuck_out_tongue_closed_eyes
142|winking face with tongue prank silly stuck_out_tongue_winking_eye
143|smiling face with sunglasses cool sunglasses
145|sweat droplets water workout sweat_drops
146|grinning face with sweat hot sweat_smile
148|thought balloon thinking thought_balloon
149|tired face upset whine tired_face
150|face with steam from nose smug triumph
152|unamused face meh unamused
154|face vomiting barf sick vomiting_face
155|weary face tired weary
157|winking face flirt wink
158|woozy face groggy woozy_face
159|worried face nervous worried
162|face savoring food tongue lick yum
163|zany face goofy wacky zany_face
164|zipper-mouth face silence hush zipper_mouth_face
165|zzz sleeping zzz
166|thumbs up approve ok +1 thumbsup
167|thumbs down disapprove bury -1 thumbsdown
173|baby child newborn baby
176|person taking bath shower bath
187|person bouncing ball basketball bouncing_ball_person
189|person bowing respect thanks bow
190|man bowing respect thanks bowing_man
191|woman bowing respect thanks bowing_woman
192|boy child boy
194|breast-feeding nursing breast_feeding
196|bust in silhouette user bust_in_silhouette
197|busts in silhouette users group team busts_in_silhouette
201|clapping hands praise applause clap
202|person climbing bouldering climbing
203|man climbing bouldering climbing_man
204|woman climbing bouldering climbing_woman
205|construction worker helmet construction_worker
206|man construction worker helmet construction_worker_man
207|woman construction worker helmet construction_worker_woman
209|woman and man holding hands date couple
218|crossed fingers luck hopeful crossed_fingers
221|people with bunny ears bunny dancers
222|men with bunny ears bunny dancing_men
223|women with bunny ears bunny dancing_women
227|detective sleuth detective
228|ear hear sound listen ear
234|eyes look see watch eyes
240|family home parents child family
267|woman detective sleuth female_detective
270|oncoming fist attack fist_oncoming facepunch punch
271|raised fist power fist_raised fist
274|footprints feet tracks footprints
281|girl child girl
288|person getting haircut beauty haircut
291|raised hand highfive stop hand raised_hand
294|handshake deal handshake
296|heart hands love heart_hands
307|mouth kiss lips
308|person in lotus position meditation lotus_position
309|man in lotus position meditation lotus_position_man
310|woman in lotus position meditation lotus_position_woman
313|mage wizard mage
314|man mage wizard mage_man
315|woman mage wizard mage_woman
316|man detective sleuth male_detective
317|man mustache father dad man
318|man artist painter man_artist
319|man astronaut space man_astronaut
322|man cook chef man_cook
323|man dancing dancer man_dancing
329|man health worker doctor nurse man_health_worker
333|man judge justice man_judge
336|man office worker business man_office_worker
340|man scientist research man_scientist
342|man singer rockstar man_singer
343|man student graduation man_student
344|man teacher school professor man_teacher
345|man technologist coder man_technologist
350|person getting massage spa massage
351|man getting massage spa massage_man
352|woman getting massage spa massage_woman
365|mrs. claus santa mrs_claus
366|flexed biceps flex bicep strong workout muscle
368|nail polish beauty manicure nail_care
370|person gesturing no stop halt denied no_good
371|man gesturing no stop halt denied no_good_man ng_man
372|woman gesturing no stop halt denied no_good_woman ng_woman
373|nose smell nose
375|ok hand ok_hand
376|man gesturing ok ok_man
377|person gesturing ok ok_person
378|woman gesturing ok ok_woman
386|people holding hands couple date people_holding_hands
394|person in tuxedo groom marriage wedding person_in_tuxedo
400|person with veil marriage wedding person_with_veil
409|police officer law police_officer cop
410|man police officer law cop policeman
411|woman police officer law cop policewoman
415|folded hands please hope wish pray
419|prince crown royal prince
420|princess crown royal princess
423|raising hands hooray raised_hands
434|person running exercise workout marathon runner running
435|man running exercise workout marathon running_man
436|woman running exercise workout marathon running_woman
437|santa claus christmas santa
438|man in steamy room steamy sauna_man
439|person in steamy room steamy sauna_person
440|woman in steamy room steamy sauna_woman
467|man tipping hand information tipping_hand_man sassy_man
469|woman tipping hand information tipping_hand_woman sassy_woman
470|tongue taste tongue
473|men holding hands couple date two_men_holding_hands
474|women holding hands couple date two_women_holding_hands
475|victory hand victory peace v
479|vulcan salute prosper spock vulcan_salute
484|waving hand goodbye wave
485|person lifting weights gym workout weight_lifting
486|man lifting weights gym workout weight_lifting_man
487|woman lifting weights gym workout weight_lifting_woman
490|woman girls woman
491|woman artist painter woman_artist
492|woman astronaut space woman_astronaut
495|woman cook chef woman_cook
496|woman dancing dress woman_dancing dancer
502|woman health worker doctor nurse woman_health_worker
506|woman judge justice woman_judge
509|woman office worker business woman_office_worker
513|woman scientist research woman_scientist
515|woman singer rockstar woman_singer
516|woman student graduation woman_student
517|woman teacher school professor woman_teacher
518|woman technologist coder woman_technologist
519|woman with headscarf hijab woman_with_headscarf
544|bouquet flowers bouquet
549|cat face pet cat
551|cherry blossom flower spring cherry_blossom
560|deciduous tree wood deciduous_tree
563|dog face pet dog
566|donkey mule donkey
567|dove peace dove
570|camel desert dromedary_camel
576|evergreen tree wood evergreen_tree
577|fallen leaf autumn fallen_leaf
583|four leaf clover luck four_leaf_clover
588|goose honk goose
591|hamster pet hamster
603|lady beetle bug lady_beetle
604|leaf fluttering in wind leaf leaves
611|maple leaf canada maple_leaf
612|microbe germ microbe
615|moose canada moose
619|mushroom fungus mushroom
635|poodle dog poodle
637|rabbit face bunny rabbit
640|horse speed racehorse
645|rose flower rose
647|sauropod dinosaur sauropod
650|seedling plant seedling
655|spiral shell sea beach shell
658|snail slow snail
664|t-rex dinosaur t-rex
668|tulip flower tulip
669|turkey thanksgiving turkey
670|turtle slow turtle
673|spouting whale sea whale
677|wing fly wing
684|baby bottle milk baby_bottle
688|banana fruit banana
690|beer mug drink beer
691|clinking beer mugs drinks beers
695|birthday cake party birthday
698|bread toast bread
703|shortcake dessert cake
704|candy sweet candy
707|bottle with popping cork bottle bubbly celebration champagne
709|cherries fruit cherries
713|clinking glasses cheers toast clinking_glasses
714|cocktail glass drink cocktail
716|hot beverage cafe espresso coffee
731|eggplant aubergine eggplant
736|fork and knife cutlery fork_and_knife
738|cooking breakfast fried_egg
739|fried shrimp tempura fried_shrimp
744|green apple fruit green_apple
746|hamburger burger hamburger
747|kitchen knife cut chop hocho knife
749|hot pepper spicy hot_pepper
778|fork and knife with plate dining dinner plate_with_cutlery
781|poultry leg meat chicken poultry_leg
784|steaming bowl noodle ramen
791|shallow pan of food paella curry shallow_pan_of_food
794|spaghetti pasta spaghetti
798|strawberry fruit strawberry
806|teacup without handle green breakfast tea
809|tropical drink summer vacation tropical_drink
810|tumbler glass whisky tumbler_glass
814|1st place medal gold 1st_place_medal
815|2nd place medal silver 2nd_place_medal
816|3rd place medal bronze 3rd_place_medal
817|pool 8 ball pool billiards 8ball
818|artist palette design paint art
820|balloon party birthday balloon
822|baseball sports baseball
823|basketball sports basketball
828|christmas tree christmas_tree
832|crystal ball fortune crystal_ball
834|bullseye target dart
837|japanese dolls dolls
840|fireworks festival celebration fireworks
845|american football sports football
847|game die dice gambling game_die
848|wrapped gift present birthday christmas gift
851|water pistol shoot weapon gun
854|ice skate skating ice_skate
855|jack-o-lantern halloween jack_o_lantern
865|sports medal gold winner medal_sports
866|mirror ball disco party mirror_ball
868|performing arts theater drama performing_arts
876|running shirt marathon running_shirt_with_sash
881|soccer ball sports soccer
885|sparkles shiny sparkles
886|party popper hooray party tada
889|tennis sports tennis
893|trophy award contest winner trophy
894|video game play controller console video_game
900|airplane flight airplane
901|alarm clock morning alarm_clock
903|anchor ship anchor
905|satellite orbit space artificial_satellite
911|bicycle bicycle bike
917|bullet train train bullettrain_front
918|high-speed train train bullettrain_side
929|cityscape skyline cityscape
955|closed umbrella weather rain closed_umbrella
963|construction wip construction
965|crescent moon night crescent_moon
966|cyclone swirl cyclone
971|droplet water droplet
972|globe showing europe-africa globe world international earth_africa
973|globe showing americas globe world international earth_americas
974|globe showing asia-australia globe world international earth_asia
980|fire burn fire
986|flying saucer ufo flying_saucer
988|foggy karl foggy
993|globe with meridians world global international globe_with_meridians
999|hourglass done time hourglass
1000|hourglass not done time hourglass_flowing_sand
1005|map of japan japan
1006|japanese castle japanese_castle
1036|water wave sea ocean
1045|umbrella on ground beach_umbrella parasol_on_ground
1046|sun behind cloud weather cloud partly_sunny
1047|passenger ship cruise passenger_ship
1051|japanese post office post_office
1056|ring buoy life preserver ring_buoy
1059|rocket ship launch rocket
1062|police car light 911 emergency rotating_light
1068|small airplane flight small_airplane
1069|snowflake winter cold weather snowflake
1070|snowman without snow winter snowman
1071|snowman winter christmas snowman_with_snow
1072|speedboat ship speedboat
1078|statue of liberty statue_of_liberty
1079|locomotive train steam_locomotive
1085|sun with face summer sun_with_face
1086|sun weather sunny
1092|tent camping tent
1095|tokyo tower tokyo_tower
1104|umbrella with rain drops rain weather umbrella
1105|vertical traffic light semaphore vertical_traffic_light
1109|watch time watch
1111|wedding marriage wedding
1115|world map travel world_map
1116|high voltage lightning thunder zap
1121|running shoe sneaker sport running athletic_shoe
1127|bar chart stats metrics bar_chart
1130|battery power battery
1132|bell sound notification bell
1133|bikini beach bikini
1137|bomb boom bomb
1141|books library books
1144|bow and arrow archery bow_and_arrow
1145|briefcase business briefcase
1149|light bulb idea light bulb
1150|tear-off calendar schedule calendar
1151|mobile phone with arrow call incoming calling
1152|camera photo camera
1153|camera with flash photo camera_flash
1163|chart decreasing graph metrics chart_with_downwards_trend
1164|chart increasing graph metrics chart_with_upwards_trend
1166|clapper board film clapper
1169|locked with key security closed_lock_with_key
1171|coffin funeral coffin
1173|laptop desktop screen computer
1178|credit card subscription credit_card
1180|crown king queen royal crown
1184|calendar calendar schedule date
1188|dollar banknote money dollar
1197|envelope letter email envelope
1200|glasses glasses eyeglasses
1203|file folder directory file_folder
1209|floppy disk save floppy_disk
1210|flute recorder flute
1211|folding hand fan sensu folding_hand_fan
1215|gem stone diamond gem
1219|guitar rock guitar
1221|hammer tool hammer
1225|handbag bag handbag
1226|headphone music earphones headphones
1228|high-heeled shoe shoe high_heel
1234|mobile phone smartphone mobile iphone
1236|jeans pants jeans
1237|key lock password key
1241|label tag label
1246|lipstick makeup lipstick
1247|locked security private lock
1251|speaker high volume volume loud_sound
1252|loudspeaker announcement loudspeaker
1254|magnifying glass tilted left search zoom mag
1262|maracas shaker maracas
1264|memo document note memo pencil
1265|microphone sing microphone
1266|microscope science laboratory investigate microscope
1270|money with wings dollar money_with_wings
1271|money bag dollar cream moneybag
1272|graduation cap education college university graduation mortar_board
1274|movie camera film video movie_camera
1275|moai stone moyai
1276|musical keyboard piano musical_keyboard
1279|muted speaker sound volume mute
1281|necktie shirt formal necktie
1282|newspaper press newspaper
1283|rolled-up newspaper press newspaper_roll
1284|bell with slash volume off no_bell
1287|musical notes music notes
1294|package shipping package
1295|page facing up document page_facing_up
1306|pill health medicine pill
1311|clutch bag bag pouch
1317|pushpin location pushpin
1318|radio podcast radio
1322|ring wedding marriage engaged ring
1323|roll of paper toilet roll_of_paper
1324|round pushpin location round_pushpin
1327|woman’s sandal shoe sandal
1329|satellite antenna signal satellite
1333|scissors cut scissors
1335|scroll document scroll
1338|shopping bags bags shopping
1341|shower bath shower
1342|cigarette cigarette smoking
1345|speaker medium volume volume sound
1352|studio microphone podcast studio_microphone
1354|syringe health hospital needle syringe
1355|telephone receiver phone call telephone_receiver
1359|toilet wc toilet
1362|top hat hat classy tophat
1367|unlocked security unlock
1371|wastebasket trash wastebasket
1375|wrench tool wrench
1378|input numbers numbers 1234
1379|a button (blood type) a
1380|ab button (blood type) ab
1381|input latin letters alphabet abc
1383|japanese “acceptable” button accept
1384|aquarius aquarius
1385|aries aries
1405|counterclockwise arrows button sync arrows_counterclockwise
1407|atm sign atm
1409|b button (blood type) b
1411|back arrow back
1412|baggage claim airport baggage_claim
1415|japanese symbol for beginner beginner
1426|cancer cancer
1427|input latin uppercase letters capital_abcd
1428|capricorn capricorn
1430|cinema film movie cinema
1431|cl button cl
1432|japanese “congratulations” button congratulations
1433|cool button cool
1444|end arrow end
1445|red exclamation mark bang exclamation heavy_exclamation_mark
1451|free button free
1452|gemini gemini
1457|keycap: # number hash
1466|id button id
1467|japanese “bargain” button ideograph_advantage
1473|japanese “here” button koko
1480|right arrow curving left return leftwards_arrow_with_hook
1481|leo leo
1482|libra libra
1485|circled m m
1490|mobile phone off mute off mobile_phone_off
1493|new button fresh new
1495|ng button ng
1498|no entry limit no_entry
1499|prohibited block forbidden no_entry_sign
1505|o button (blood type) o2
1506|ok button yes ok
1508|on! arrow on
1510|ophiuchus ophiuchus
1514|p button parking
1519|pisces pisces
1527|red question mark confused question
1531|recycling symbol environment green recycle
1535|repeat button loop repeat
1537|restroom toilet restroom
1539|japanese “service charge” button sa
1540|sagittarius sagittarius
1541|scorpio scorpius
1542|japanese “secret” button secret
1544|antenna bars wifi signal_strength
1551|soon arrow soon
1552|sos button help emergency sos
1555|star of david star_of_david
1558|taurus taurus
1560|trade mark trademark tm
1561|top arrow top
1564|shuffle tracks button shuffle twisted_rightwards_arrows
1566|japanese “discount” button u5272
1567|japanese “passing grade” button u5408
1568|japanese “open for business” button u55b6
1569|japanese “reserved” button u6307
1570|japanese “monthly amount” button u6708
1571|japanese “not free of charge” button u6709
1572|japanese “no vacancy” button u6e80
1573|japanese “free of charge” button u7121
1574|japanese “application” button u7533
1575|japanese “prohibited” button u7981
1576|japanese “vacancy” button u7a7a
1578|up! button up
1580|virgo virgo
1581|vs button vs
1582|warning wip warning
1584|water closet toilet restroom wc
1586|wheelchair symbol accessibility wheelchair
1594|wireless wifi wireless
1601|flag: afghanistan afghanistan
1602|flag: åland islands aland_islands
1603|flag: albania albania
1604|flag: algeria algeria
1605|flag: american samoa american_samoa
1606|flag: andorra andorra
1607|flag: angola angola
1608|flag: anguilla anguilla
1609|flag: antarctica antarctica
1610|flag: antigua & barbuda antigua_barbuda
1611|flag: argentina argentina
1612|flag: armenia armenia
1613|flag: aruba aruba
1614|flag: ascension island ascension_island
1615|flag: australia australia
1616|flag: austria austria
1617|flag: azerbaijan azerbaijan
1618|flag: bahamas bahamas
1619|flag: bahrain bahrain
1620|flag: bangladesh bangladesh
1621|flag: barbados barbados
1622|flag: belarus belarus
1623|flag: belgium belgium
1624|flag: belize belize
1625|flag: benin benin
1626|flag: bermuda bermuda
1627|flag: bhutan bhutan
1629|flag: bolivia bolivia
1630|flag: bosnia & herzegovina bosnia_herzegovina
1631|flag: botswana botswana
1632|flag: bouvet island bouvet_island
1633|flag: brazil brazil
1634|flag: british indian ocean territory british_indian_ocean_territory
1635|flag: british virgin islands british_virgin_islands
1636|flag: brunei brunei
1637|flag: bulgaria bulgaria
1638|flag: burkina faso burkina_faso
1639|flag: burundi burundi
1640|flag: cambodia cambodia
1641|flag: cameroon cameroon
1642|flag: canada canada
1643|flag: canary islands canary_islands
1644|flag: cape verde cape_verde
1645|flag: caribbean netherlands caribbean_netherlands
1646|flag: cayman islands cayman_islands
1647|flag: central african republic central_african_republic
1648|flag: ceuta & melilla ceuta_melilla
1649|flag: chad chad
1650|chequered flag milestone finish checkered_flag
1651|flag: chile chile
1652|flag: christmas island christmas_island
1653|flag: clipperton island clipperton_island
1654|flag: china china cn
1655|flag: cocos (keeling) islands keeling cocos_islands
1656|flag: colombia colombia
1657|flag: comoros comoros
1658|flag: congo - brazzaville congo_brazzaville
1659|flag: congo - kinshasa congo_kinshasa
1660|flag: cook islands cook_islands
1661|flag: costa rica costa_rica
1662|flag: côte d’ivoire ivory cote_divoire
1663|flag: croatia croatia
1665|flag: cuba cuba
1666|flag: curaçao curacao
1667|flag: cyprus cyprus
1668|flag: czechia czech_republic
1669|flag: germany flag germany de
1670|flag: denmark denmark
1671|flag: diego garcia diego_garcia
1672|flag: djibouti djibouti
1673|flag: dominica dominica
1674|flag: dominican republic dominican_republic
1675|flag: ecuador ecuador
1676|flag: egypt egypt
1677|flag: el salvador el_salvador
1678|flag: england england
1679|flag: equatorial guinea equatorial_guinea
1680|flag: eritrea eritrea
1681|flag: spain spain es
1682|flag: estonia estonia
1683|flag: ethiopia ethiopia
1684|flag: european union eu european_union
1685|flag: falkland islands falkland_islands
1686|flag: faroe islands faroe_islands
1687|flag: fiji fiji
1688|flag: finland finland
1689|flag: france france french fr
1690|flag: french guiana french_guiana
1691|flag: french polynesia french_polynesia
1692|flag: french southern territories french_southern_territories
1693|flag: gabon gabon
1694|flag: gambia gambia
1695|flag: united kingdom flag british gb uk
1696|flag: georgia georgia
1697|flag: ghana ghana
1698|flag: gibraltar gibraltar
1699|flag: greece greece
1700|flag: greenland greenland
1701|flag: grenada grenada
1702|flag: guadeloupe guadeloupe
1703|flag: guam guam
1704|flag: guatemala guatemala
1705|flag: guernsey guernsey
1706|flag: guinea guinea
1707|flag: guinea-bissau guinea_bissau
1708|flag: guyana guyana
1709|flag: haiti haiti
1710|flag: heard & mcdonald islands heard_mcdonald_islands
1711|flag: honduras honduras
1712|flag: hong kong sar china hong_kong
1713|flag: hungary hungary
1714|flag: iceland iceland
1715|flag: india india
1716|flag: indonesia indonesia
1717|flag: iran iran
1718|flag: iraq iraq
1719|flag: ireland ireland
1720|flag: isle of man isle_of_man
1721|flag: israel israel
1722|flag: italy italy it
1723|flag: jamaica jamaica
1724|flag: jersey jersey
1725|flag: jordan jordan
1726|flag: japan japan jp
1727|flag: kazakhstan kazakhstan
1728|flag: kenya kenya
1729|flag: kiribati kiribati
1730|flag: kosovo kosovo
1731|flag: south korea korea kr
1732|flag: kuwait kuwait
1733|flag: kyrgyzstan kyrgyzstan
1734|flag: laos laos
1735|flag: latvia latvia
1736|flag: lebanon lebanon
1737|flag: lesotho lesotho
1738|flag: liberia liberia
1739|flag: libya libya
1740|flag: liechtenstein liechtenstein
1741|flag: lithuania lithuania
1742|flag: luxembourg luxembourg
1743|flag: macao sar china macau
1744|flag: north macedonia macedonia
1745|flag: madagascar madagascar
1746|flag: malawi malawi
1747|flag: malaysia malaysia
1748|flag: maldives maldives
1749|flag: mali mali
1750|flag: malta malta
1751|flag: marshall islands marshall_islands
1752|flag: martinique martinique
1753|flag: mauritania mauritania
1754|flag: mauritius mauritius
1755|flag: mayotte mayotte
1756|flag: mexico mexico
1757|flag: micronesia micronesia
1758|flag: moldova moldova
1759|flag: monaco monaco
1760|flag: mongolia mongolia
1761|flag: montenegro montenegro
1762|flag: montserrat montserrat
1763|flag: morocco morocco
1764|flag: mozambique mozambique
1765|flag: myanmar (burma) burma myanmar
1766|flag: namibia namibia
1767|flag: nauru nauru
1768|flag: nepal nepal
1769|flag: netherlands netherlands
1770|flag: new caledonia new_caledonia
1771|flag: new zealand new_zealand
1772|flag: nicaragua nicaragua
1773|flag: niger niger
1774|flag: nigeria nigeria
1775|flag: niue niue
1776|flag: norfolk island norfolk_island
1777|flag: north korea north_korea
1778|flag: northern mariana islands northern_mariana_islands
1779|flag: norway norway
1780|flag: oman oman
1781|flag: pakistan pakistan
1782|flag: palau palau
1783|flag: palestinian territories palestinian_territories
1784|flag: panama panama
1785|flag: papua new guinea papua_new_guinea
1786|flag: paraguay paraguay
1787|flag: peru peru
1788|flag: philippines philippines
1790|flag: pitcairn islands pitcairn_islands
1791|flag: poland poland
1792|flag: portugal portugal
1793|flag: puerto rico puerto_rico
1794|flag: qatar qatar
1795|rainbow flag pride rainbow_flag
1796|flag: réunion reunion
1797|flag: romania romania
1798|flag: russia russia ru
1799|flag: rwanda rwanda
1800|flag: samoa samoa
1801|flag: san marino san_marino
1802|flag: são tomé & príncipe sao_tome_principe
1803|flag: saudi arabia saudi_arabia
1804|flag: scotland scotland
1805|flag: senegal senegal
1806|flag: serbia serbia
1807|flag: seychelles seychelles
1808|flag: sierra leone sierra_leone
1809|flag: singapore singapore
1810|flag: sint maarten sint_maarten
1811|flag: slovakia slovakia
1812|flag: slovenia slovenia
1813|flag: solomon islands solomon_islands
1814|flag: somalia somalia
1815|flag: south africa south_africa
1816|flag: south georgia & south sandwich islands south_georgia_south_sandwich_islands
1817|flag: south sudan south_sudan
1818|flag: sri lanka sri_lanka
1819|flag: st. barthélemy st_barthelemy
1820|flag: st. helena st_helena
1821|flag: st. kitts & nevis st_kitts_nevis
1822|flag: st. lucia st_lucia
1823|flag: st. martin st_martin
1824|flag: st. pierre & miquelon st_pierre_miquelon
1825|flag: st. vincent & grenadines st_vincent_grenadines
1826|flag: sudan sudan
1827|flag: suriname suriname
1828|flag: svalbard & jan mayen svalbard_jan_mayen
1829|flag: eswatini swaziland
1830|flag: sweden sweden
1831|flag: switzerland switzerland
1832|flag: syria syria
1833|flag: taiwan taiwan
1834|flag: tajikistan tajikistan
1835|flag: tanzania tanzania
1836|flag: thailand thailand
1837|flag: timor-leste timor_leste
1838|flag: togo togo
1839|flag: tokelau tokelau
1840|flag: tonga tonga
1841|flag: turkey turkey tr
1844|flag: trinidad & tobago trinidad_tobago
1845|flag: tristan da cunha tristan_da_cunha
1846|flag: tunisia tunisia
1847|flag: turkmenistan turkmenistan
1848|flag: turks & caicos islands turks_caicos_islands
1849|flag: tuvalu tuvalu
1850|flag: uganda uganda
1851|flag: ukraine ukraine
1852|flag: united arab emirates united_arab_emirates
1853|flag: united nations united_nations
1854|flag: uruguay uruguay
1855|flag: united states flag united america us
1856|flag: u.s. outlying islands us_outlying_islands
1857|flag: u.s. virgin islands us_virgin_islands
1858|flag: uzbekistan uzbekistan
1859|flag: vanuatu vanuatu
1860|flag: vatican city vatican_city
1861|flag: venezuela venezuela
1862|flag: vietnam vietnam
1863|flag: wales wales
1864|flag: wallis & futuna wallis_futuna
1865|flag: western sahara western_sahara
1867|flag: yemen yemen
1868|flag: zambia zambia
1869|flag: zimbabwe zimbabwe
`.trim();

function buildRows() {
  const overrides = new Map();
  for (const line of SEARCH_OVERRIDES.split("\n")) {
    const pipe = line.indexOf("|");
    overrides.set(Number(line.slice(0, pipe)), line.slice(pipe + 1));
  }
  const rows = [];
  let index = 0;
  for (const line of ROW_DATA.split("\n")) {
    const [emoji, primary, extras, categoryIndex, description] = line.split("|");
    const category = CATEGORIES[Number(categoryIndex)];
    const search = overrides.get(index) ?? `${description} ${primary} ${extras}`.replace(/\s+/g, " ").trim();
    rows.push(Object.freeze([emoji, primary, extras, category, description, search]));
    index += 1;
  }
  return rows;
}

export const EMOJI_ROWS = Object.freeze(buildRows());
