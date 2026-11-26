import Foundation
import SwiftData

/// Built-in exercises, seeded on first launch. Names follow the
/// "Movement (Equipment)" convention so a Strong export lines up with them.
enum ExerciseLibrary {
    /// Bump when adding lines below; missing ones get inserted on next launch.
    static let version = 1

    struct Item {
        let name: String
        let muscle: MuscleGroup
        let equipment: Equipment
    }

    static let all: [Item] = raw
        .split(whereSeparator: \.isNewline)
        .compactMap { line in
            let parts = line.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 3,
                  let muscle = MuscleGroup(rawValue: parts[1]),
                  let equipment = Equipment(rawValue: parts[2]) else { return nil }
            return Item(name: parts[0], muscle: muscle, equipment: equipment)
        }

    @MainActor
    static func seedIfNeeded(_ context: ModelContext) {
        let key = "exerciseLibraryVersion"
        let existing = (try? context.fetch(FetchDescriptor<Exercise>())) ?? []
        // The version flag keeps built-ins you deleted from coming back; an empty
        // store means the database is new, whatever the flag says.
        guard UserDefaults.standard.integer(forKey: key) < version || existing.isEmpty else { return }
        var known = Set(existing.map { Exercise.normalize($0.name) })
        for item in all where known.insert(Exercise.normalize(item.name)).inserted {
            context.insert(Exercise(name: item.name, muscle: item.muscle, equipment: item.equipment))
        }
        try? context.save()
        UserDefaults.standard.set(version, forKey: key)
    }

    private static let raw = """
    Bench Press (Barbell)|chest|barbell
    Bench Press (Dumbbell)|chest|dumbbell
    Bench Press (Smith Machine)|chest|machine
    Incline Bench Press (Barbell)|chest|barbell
    Incline Bench Press (Dumbbell)|chest|dumbbell
    Incline Bench Press (Smith Machine)|chest|machine
    Decline Bench Press (Barbell)|chest|barbell
    Decline Bench Press (Dumbbell)|chest|dumbbell
    Chest Press (Machine)|chest|machine
    Incline Chest Press (Machine)|chest|machine
    Chest Fly (Dumbbell)|chest|dumbbell
    Incline Chest Fly (Dumbbell)|chest|dumbbell
    Chest Fly (Machine)|chest|machine
    Chest Fly (Cable)|chest|cable
    Cable Crossover|chest|cable
    Low to High Cable Fly|chest|cable
    High to Low Cable Fly|chest|cable
    Push Up|chest|bodyweight
    Incline Push Up|chest|bodyweight
    Decline Push Up|chest|bodyweight
    Chest Dip|chest|bodyweight
    Floor Press (Dumbbell)|chest|dumbbell
    Pullover (Dumbbell)|chest|dumbbell
    Deadlift (Barbell)|back|barbell
    Rack Pull (Barbell)|back|barbell
    Pull Up|back|bodyweight
    Pull Up (Assisted)|back|machine
    Pull Up (Weighted)|back|other
    Chin Up|back|bodyweight
    Neutral Grip Pull Up|back|bodyweight
    Lat Pulldown (Cable)|back|cable
    Lat Pulldown (Machine)|back|machine
    Close Grip Lat Pulldown (Cable)|back|cable
    Single Arm Lat Pulldown (Cable)|back|cable
    Straight Arm Pulldown (Cable)|back|cable
    Bent Over Row (Barbell)|back|barbell
    Bent Over Row (Dumbbell)|back|dumbbell
    Bent Over One Arm Row (Dumbbell)|back|dumbbell
    Pendlay Row (Barbell)|back|barbell
    T Bar Row|back|barbell
    Seated Row (Cable)|back|cable
    Seated Row (Machine)|back|machine
    Single Arm Row (Cable)|back|cable
    Chest Supported Row (Dumbbell)|back|dumbbell
    Chest Supported Row (Machine)|back|machine
    Meadows Row|back|barbell
    Inverted Row|back|bodyweight
    Back Extension|back|bodyweight
    Good Morning (Barbell)|hamstrings|barbell
    Shrug (Barbell)|back|barbell
    Shrug (Dumbbell)|back|dumbbell
    Overhead Press (Barbell)|shoulders|barbell
    Overhead Press (Dumbbell)|shoulders|dumbbell
    Seated Overhead Press (Barbell)|shoulders|barbell
    Seated Overhead Press (Dumbbell)|shoulders|dumbbell
    Shoulder Press (Machine)|shoulders|machine
    Shoulder Press (Smith Machine)|shoulders|machine
    Arnold Press (Dumbbell)|shoulders|dumbbell
    Push Press (Barbell)|shoulders|barbell
    Landmine Press|shoulders|barbell
    Lateral Raise (Dumbbell)|shoulders|dumbbell
    Lateral Raise (Cable)|shoulders|cable
    Lateral Raise (Machine)|shoulders|machine
    Front Raise (Dumbbell)|shoulders|dumbbell
    Front Raise (Cable)|shoulders|cable
    Front Raise (Plate)|shoulders|other
    Reverse Fly (Dumbbell)|shoulders|dumbbell
    Reverse Fly (Cable)|shoulders|cable
    Reverse Fly (Machine)|shoulders|machine
    Face Pull (Cable)|shoulders|cable
    Upright Row (Barbell)|shoulders|barbell
    Upright Row (Cable)|shoulders|cable
    Pike Push Up|shoulders|bodyweight
    Handstand Push Up|shoulders|bodyweight
    Bicep Curl (Barbell)|biceps|barbell
    Bicep Curl (EZ Bar)|biceps|barbell
    Bicep Curl (Dumbbell)|biceps|dumbbell
    Bicep Curl (Cable)|biceps|cable
    Bicep Curl (Machine)|biceps|machine
    Hammer Curl (Dumbbell)|biceps|dumbbell
    Hammer Curl (Cable)|biceps|cable
    Incline Curl (Dumbbell)|biceps|dumbbell
    Preacher Curl (Barbell)|biceps|barbell
    Preacher Curl (Dumbbell)|biceps|dumbbell
    Preacher Curl (Machine)|biceps|machine
    Concentration Curl (Dumbbell)|biceps|dumbbell
    Spider Curl (Dumbbell)|biceps|dumbbell
    Bayesian Curl (Cable)|biceps|cable
    Reverse Curl (Barbell)|forearms|barbell
    Zottman Curl (Dumbbell)|biceps|dumbbell
    Triceps Pushdown (Cable)|triceps|cable
    Triceps Rope Pushdown (Cable)|triceps|cable
    Single Arm Triceps Pushdown (Cable)|triceps|cable
    Overhead Triceps Extension (Cable)|triceps|cable
    Overhead Triceps Extension (Dumbbell)|triceps|dumbbell
    Triceps Extension (Machine)|triceps|machine
    Skullcrusher (Barbell)|triceps|barbell
    Skullcrusher (EZ Bar)|triceps|barbell
    Skullcrusher (Dumbbell)|triceps|dumbbell
    Close Grip Bench Press (Barbell)|triceps|barbell
    JM Press (Barbell)|triceps|barbell
    Triceps Dip|triceps|bodyweight
    Bench Dip|triceps|bodyweight
    Diamond Push Up|triceps|bodyweight
    Triceps Kickback (Dumbbell)|triceps|dumbbell
    Triceps Kickback (Cable)|triceps|cable
    Wrist Curl (Barbell)|forearms|barbell
    Wrist Curl (Dumbbell)|forearms|dumbbell
    Reverse Wrist Curl (Barbell)|forearms|barbell
    Farmer's Walk|forearms|dumbbell
    Dead Hang|forearms|bodyweight
    Squat (Barbell)|quads|barbell
    Front Squat (Barbell)|quads|barbell
    Squat (Smith Machine)|quads|machine
    Box Squat (Barbell)|quads|barbell
    Goblet Squat (Dumbbell)|quads|dumbbell
    Goblet Squat (Kettlebell)|quads|kettlebell
    Hack Squat (Machine)|quads|machine
    Pendulum Squat (Machine)|quads|machine
    Belt Squat (Machine)|quads|machine
    Leg Press|quads|machine
    Single Leg Press|quads|machine
    Leg Extension (Machine)|quads|machine
    Bulgarian Split Squat (Dumbbell)|quads|dumbbell
    Split Squat (Dumbbell)|quads|dumbbell
    Lunge (Dumbbell)|quads|dumbbell
    Lunge (Barbell)|quads|barbell
    Walking Lunge (Dumbbell)|quads|dumbbell
    Reverse Lunge (Dumbbell)|quads|dumbbell
    Step Up (Dumbbell)|quads|dumbbell
    Sissy Squat|quads|bodyweight
    Pistol Squat|quads|bodyweight
    Bodyweight Squat|quads|bodyweight
    Wall Sit|quads|bodyweight
    Romanian Deadlift (Barbell)|hamstrings|barbell
    Romanian Deadlift (Dumbbell)|hamstrings|dumbbell
    Single Leg Romanian Deadlift (Dumbbell)|hamstrings|dumbbell
    Stiff Leg Deadlift (Barbell)|hamstrings|barbell
    Sumo Deadlift (Barbell)|hamstrings|barbell
    Trap Bar Deadlift|hamstrings|barbell
    Lying Leg Curl (Machine)|hamstrings|machine
    Seated Leg Curl (Machine)|hamstrings|machine
    Standing Leg Curl (Machine)|hamstrings|machine
    Nordic Hamstring Curl|hamstrings|bodyweight
    Glute Ham Raise|hamstrings|bodyweight
    Hip Thrust (Barbell)|glutes|barbell
    Hip Thrust (Machine)|glutes|machine
    Hip Thrust (Dumbbell)|glutes|dumbbell
    Glute Bridge|glutes|bodyweight
    Single Leg Glute Bridge|glutes|bodyweight
    Glute Kickback (Cable)|glutes|cable
    Glute Kickback (Machine)|glutes|machine
    Hip Abduction (Machine)|glutes|machine
    Hip Abduction (Cable)|glutes|cable
    Hip Adduction (Machine)|glutes|machine
    Cable Pull Through|glutes|cable
    Frog Pump|glutes|bodyweight
    Standing Calf Raise (Machine)|calves|machine
    Standing Calf Raise (Dumbbell)|calves|dumbbell
    Standing Calf Raise (Smith Machine)|calves|machine
    Seated Calf Raise (Machine)|calves|machine
    Calf Press (Leg Press)|calves|machine
    Single Leg Calf Raise|calves|bodyweight
    Tibialis Raise|calves|bodyweight
    Plank|core|bodyweight
    Side Plank|core|bodyweight
    Copenhagen Plank|core|bodyweight
    Hollow Hold|core|bodyweight
    Crunch|core|bodyweight
    Crunch (Machine)|core|machine
    Cable Crunch|core|cable
    Decline Crunch|core|bodyweight
    Bicycle Crunch|core|bodyweight
    Sit Up|core|bodyweight
    V Up|core|bodyweight
    Hanging Leg Raise|core|bodyweight
    Hanging Knee Raise|core|bodyweight
    Lying Leg Raise|core|bodyweight
    Toes to Bar|core|bodyweight
    Ab Wheel Rollout|core|other
    Russian Twist|core|bodyweight
    Mountain Climber|core|bodyweight
    Dead Bug|core|bodyweight
    Bird Dog|core|bodyweight
    Pallof Press (Cable)|core|cable
    Woodchopper (Cable)|core|cable
    Power Clean (Barbell)|fullBody|barbell
    Clean and Jerk (Barbell)|fullBody|barbell
    Snatch (Barbell)|fullBody|barbell
    Thruster (Barbell)|fullBody|barbell
    Thruster (Dumbbell)|fullBody|dumbbell
    Kettlebell Swing|fullBody|kettlebell
    Turkish Get Up (Kettlebell)|fullBody|kettlebell
    Burpee|fullBody|bodyweight
    Muscle Up|fullBody|bodyweight
    Box Jump|fullBody|bodyweight
    Sled Push|fullBody|other
    Battle Ropes|fullBody|other
    """
}
