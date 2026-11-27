// How strong "very strong" is, lift by lift — the yardstick behind the ranks (see ranks.ts).
//
// One line per exercise of the built-in library that can sensibly be ranked:
//
//   name | 2.0     a lift with weight: the estimated one-rep max, as a multiple of
//                  body weight, at which the top tier begins. Weight as it is logged —
//                  the bar with its plates, one dumbbell of a pair, a machine's stack.
//   name | 3-30    a bodyweight exercise: reps in one set at which Bronze begins and
//                  at which the top tier begins. Added weight counts on top.
//
// The numbers are for men; women's are derived from them in ranks.ts. The big
// barbell lifts and pull-ups follow the bodyweight-ratio tables in common use
// (elite at about 2× body weight on the bench, 2.7× in the squat, 3× in the deadlift).
// Everything else is an estimate scaled from those, and machines differ from gym
// to gym — so this is a game to make progress visible, not a certificate.
// Holds, carries and conditioning drills have no line and stay unranked.

export const STANDARD_LINES = `
Bench Press (Barbell)|2.0
Bench Press (Dumbbell)|0.92
Bench Press (Smith Machine)|1.9
Incline Bench Press (Barbell)|1.7
Incline Bench Press (Dumbbell)|0.82
Incline Bench Press (Smith Machine)|1.6
Decline Bench Press (Barbell)|2.0
Decline Bench Press (Dumbbell)|0.92
Chest Press (Machine)|2.1
Incline Chest Press (Machine)|1.8
Chest Fly (Dumbbell)|0.58
Incline Chest Fly (Dumbbell)|0.52
Chest Fly (Machine)|1.5
Chest Fly (Cable)|0.6
Cable Crossover|0.6
Low to High Cable Fly|0.45
High to Low Cable Fly|0.6
Push Up|10-70
Incline Push Up|15-90
Decline Push Up|8-60
Chest Dip|5-35
Floor Press (Dumbbell)|0.82
Pullover (Dumbbell)|0.6
Deadlift (Barbell)|3.0
Rack Pull (Barbell)|3.4
Pull Up|3-30
Pull Up (Weighted)|3-30
Chin Up|4-32
Neutral Grip Pull Up|4-32
Lat Pulldown (Cable)|1.65
Lat Pulldown (Machine)|1.65
Close Grip Lat Pulldown (Cable)|1.65
Single Arm Lat Pulldown (Cable)|0.8
Straight Arm Pulldown (Cable)|0.9
Bent Over Row (Barbell)|1.75
Bent Over Row (Dumbbell)|0.9
Bent Over One Arm Row (Dumbbell)|1.1
Pendlay Row (Barbell)|1.65
T Bar Row|1.75
Seated Row (Cable)|1.75
Seated Row (Machine)|1.75
Single Arm Row (Cable)|0.85
Chest Supported Row (Dumbbell)|0.85
Chest Supported Row (Machine)|1.7
Meadows Row|1.0
Inverted Row|5-40
Back Extension|10-60
Good Morning (Barbell)|1.6
Shrug (Barbell)|3.0
Shrug (Dumbbell)|1.3
Overhead Press (Barbell)|1.35
Overhead Press (Dumbbell)|0.68
Seated Overhead Press (Barbell)|1.3
Seated Overhead Press (Dumbbell)|0.68
Shoulder Press (Machine)|1.6
Shoulder Press (Smith Machine)|1.35
Arnold Press (Dumbbell)|0.58
Push Press (Barbell)|1.7
Landmine Press|1.0
Lateral Raise (Dumbbell)|0.42
Lateral Raise (Cable)|0.35
Lateral Raise (Machine)|0.9
Front Raise (Dumbbell)|0.42
Front Raise (Cable)|0.5
Front Raise (Plate)|0.5
Reverse Fly (Dumbbell)|0.36
Reverse Fly (Cable)|0.3
Reverse Fly (Machine)|1.1
Face Pull (Cable)|0.9
Upright Row (Barbell)|1.1
Upright Row (Cable)|1.1
Pike Push Up|5-40
Handstand Push Up|1-20
Bicep Curl (Barbell)|1.05
Bicep Curl (EZ Bar)|1.05
Bicep Curl (Dumbbell)|0.55
Bicep Curl (Cable)|1.05
Bicep Curl (Machine)|1.1
Hammer Curl (Dumbbell)|0.58
Hammer Curl (Cable)|1.0
Incline Curl (Dumbbell)|0.47
Preacher Curl (Barbell)|0.95
Preacher Curl (Dumbbell)|0.5
Preacher Curl (Machine)|1.1
Concentration Curl (Dumbbell)|0.5
Spider Curl (Dumbbell)|0.47
Bayesian Curl (Cable)|0.5
Reverse Curl (Barbell)|0.8
Zottman Curl (Dumbbell)|0.42
Triceps Pushdown (Cable)|1.15
Triceps Rope Pushdown (Cable)|1.05
Single Arm Triceps Pushdown (Cable)|0.5
Overhead Triceps Extension (Cable)|1.0
Overhead Triceps Extension (Dumbbell)|0.7
Triceps Extension (Machine)|1.4
Skullcrusher (Barbell)|0.95
Skullcrusher (EZ Bar)|0.95
Skullcrusher (Dumbbell)|0.48
Close Grip Bench Press (Barbell)|1.75
JM Press (Barbell)|1.3
Triceps Dip|5-35
Bench Dip|10-70
Diamond Push Up|6-50
Triceps Kickback (Dumbbell)|0.36
Triceps Kickback (Cable)|0.35
Wrist Curl (Barbell)|0.9
Wrist Curl (Dumbbell)|0.45
Reverse Wrist Curl (Barbell)|0.5
Squat (Barbell)|2.7
Front Squat (Barbell)|2.25
Squat (Smith Machine)|2.6
Box Squat (Barbell)|2.7
Goblet Squat (Dumbbell)|1.05
Goblet Squat (Kettlebell)|1.05
Hack Squat (Machine)|3.2
Pendulum Squat (Machine)|2.6
Belt Squat (Machine)|2.8
Leg Press|5.0
Single Leg Press|2.6
Leg Extension (Machine)|1.9
Bulgarian Split Squat (Dumbbell)|0.8
Split Squat (Dumbbell)|0.8
Lunge (Dumbbell)|0.8
Lunge (Barbell)|1.9
Walking Lunge (Dumbbell)|0.75
Reverse Lunge (Dumbbell)|0.8
Step Up (Dumbbell)|0.7
Sissy Squat|5-40
Pistol Squat|1-25
Bodyweight Squat|20-120
Romanian Deadlift (Barbell)|2.5
Romanian Deadlift (Dumbbell)|1.05
Single Leg Romanian Deadlift (Dumbbell)|0.7
Stiff Leg Deadlift (Barbell)|2.4
Sumo Deadlift (Barbell)|3.0
Trap Bar Deadlift|3.15
Lying Leg Curl (Machine)|1.3
Seated Leg Curl (Machine)|1.45
Standing Leg Curl (Machine)|0.7
Nordic Hamstring Curl|1-20
Glute Ham Raise|2-25
Hip Thrust (Barbell)|3.5
Hip Thrust (Machine)|3.5
Hip Thrust (Dumbbell)|1.4
Glute Bridge|15-100
Single Leg Glute Bridge|8-50
Glute Kickback (Cable)|0.7
Glute Kickback (Machine)|1.3
Hip Abduction (Machine)|2.0
Hip Abduction (Cable)|0.5
Hip Adduction (Machine)|2.1
Cable Pull Through|1.5
Standing Calf Raise (Machine)|3.0
Standing Calf Raise (Dumbbell)|0.9
Standing Calf Raise (Smith Machine)|3.0
Seated Calf Raise (Machine)|2.2
Calf Press (Leg Press)|4.5
Single Leg Calf Raise|8-50
Crunch|15-100
Crunch (Machine)|1.6
Cable Crunch|1.6
Decline Crunch|10-70
Sit Up|15-100
V Up|8-60
Hanging Leg Raise|4-35
Hanging Knee Raise|6-45
Lying Leg Raise|10-60
Toes to Bar|2-30
Ab Wheel Rollout|3-40
Pallof Press (Cable)|0.6
Woodchopper (Cable)|0.9
Power Clean (Barbell)|1.75
Clean and Jerk (Barbell)|2.0
Snatch (Barbell)|1.6
Thruster (Barbell)|1.5
Thruster (Dumbbell)|0.68
Kettlebell Swing|1.0
Turkish Get Up (Kettlebell)|0.65
Muscle Up|1-20
`;
