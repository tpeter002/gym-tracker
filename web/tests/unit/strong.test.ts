import { describe, expect, it } from 'vitest';
import { guessEquipment, guessMuscle } from '../../src/lib/exercises';
import { csvRecords, parseStrongCSV, parseStrongDuration, setCount, StrongFormatError } from '../../src/lib/strong';

const local = (year: number, month: number, day: number, hour: number, minute: number, second: number) =>
  new Date(year, month - 1, day, hour, minute, second).getTime();

describe('Strong CSV parser', () => {
  it('reads the older comma layout', () => {
    const csv = [
      'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE',
      '2023-03-01 18:05:10,"Push, heavy",1h 5m,"Bench Press (Barbell)",1,80.0,8,0,0,"","felt good",8.5',
      '2023-03-01 18:05:10,"Push, heavy",1h 5m,"Bench Press (Barbell)",2,82.5,6,0,0,"","felt good",',
      '2023-03-01 18:05:10,"Push, heavy",1h 5m,"Plank",1,0,0,0,60,"","felt good",',
      '2023-03-03 07:30:00,"Pull",45m,"Pull Up",1,0,10,0,0,"","",',
    ].join('\n');
    const result = parseStrongCSV(csv);

    expect(result.workouts).toHaveLength(2);
    expect(result.headerUnit).toBeNull();
    const push = result.workouts[0];
    expect(push.name).toBe('Push, heavy');
    expect(push.date).toBe(local(2023, 3, 1, 18, 5, 10));
    expect(push.duration).toBe(3900);
    expect(push.notes).toBe('felt good');
    expect(push.exercises.map((exercise) => exercise.name)).toEqual(['Bench Press (Barbell)', 'Plank']);
    expect(push.exercises[0].sets).toEqual([
      { weight: 80, reps: 8, rpe: 8.5, isWarmup: false },
      { weight: 82.5, reps: 6, rpe: null, isWarmup: false },
    ]);
    // Timed sets keep their seconds in the reps column.
    expect(push.exercises[1].sets).toEqual([{ weight: null, reps: 60, rpe: null, isWarmup: false }]);
    // Bodyweight: weight 0 means "no added weight", not a 0 kg lift.
    expect(result.workouts[1].exercises[0].sets).toEqual([{ weight: null, reps: 10, rpe: null, isWarmup: false }]);
    expect(result.workouts[1].duration).toBe(2700);
  });

  it('reads the newer semicolon layout', () => {
    const csv = [
      'Workout #;Date;Workout Name;Duration (sec);Exercise Name;Set Order;Weight (kg);Reps;RPE;Distance (meters);Seconds;Notes;Workout Notes',
      '1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";W;60;5;;;;;',
      '1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";1;100;5;9;;;;',
      '1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";Rest Timer;;;;;180;;',
      '1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";Note;;;;;;"belt on";',
      '1;2024-05-02 17:45:11;"Legs";3720;"Leg Press";1;180,5;12;;;;;',
    ].join('\n');
    const result = parseStrongCSV(csv);

    expect(result.headerUnit).toBe('kg');
    expect(result.workouts).toHaveLength(1);
    const legs = result.workouts[0];
    expect(legs.duration).toBe(3720);
    expect(legs.exercises).toHaveLength(2);
    expect(legs.exercises[0].notes).toBe('belt on');
    expect(legs.exercises[0].sets).toEqual([
      { weight: 60, reps: 5, rpe: null, isWarmup: true },
      { weight: 100, reps: 5, rpe: 9, isWarmup: false },
    ]);
    expect(legs.exercises[1].sets).toEqual([{ weight: 180.5, reps: 12, rpe: null, isWarmup: false }]);
    expect(setCount(result)).toBe(3);
  });

  it('copes with a byte-order mark and Windows line endings', () => {
    const csv = '\uFEFFDate,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps\r\n' +
      '2023-03-01 18:05:10,Push,45m,Bench Press (Barbell),1,80,8\r\n';
    expect(parseStrongCSV(csv).workouts[0].exercises[0].sets).toHaveLength(1);
  });

  it('skips rows without a readable date', () => {
    const csv = [
      'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps',
      'yesterday,Push,45m,Bench Press (Barbell),1,80,8',
      '2023-13-01 18:05:10,Push,45m,Bench Press (Barbell),1,80,8',
      '2023-03-01 18:05:10,Push,45m,Bench Press (Barbell),1,80,8',
    ].join('\n');
    const result = parseStrongCSV(csv);
    expect(result.workouts).toHaveLength(1);
    expect(result.skippedRows).toBe(2);
  });

  it('rejects files that are not Strong exports', () => {
    expect(() => parseStrongCSV('name,email\nA,b@example.com')).toThrow(
      new StrongFormatError("This doesn't look like a Strong export — missing column(s): Date, Exercise Name, Set Order, Weight, Reps."),
    );
    expect(() => parseStrongCSV('')).toThrow(new StrongFormatError('The file is empty.'));
  });

  it('lets quoted fields contain delimiters, quotes and line breaks', () => {
    expect(csvRecords('a,"b,1","say ""hi"""\r\n"two\nlines",x,y\n', ',')).toEqual([
      ['a', 'b,1', 'say "hi"'],
      ['two\nlines', 'x', 'y'],
    ]);
  });

  it('understands the duration formats', () => {
    expect(parseStrongDuration('1h 2m')).toBe(3720);
    expect(parseStrongDuration('45m')).toBe(2700);
    expect(parseStrongDuration('30s')).toBe(30);
    expect(parseStrongDuration('3720')).toBe(3720);
    expect(parseStrongDuration('')).toBeNull();
  });

  it('guesses the muscle from the more specific keyword', () => {
    expect(guessMuscle('Seated Leg Curl (Machine)')).toBe('hamstrings');
    expect(guessMuscle('Hammer Curl (Dumbbell)')).toBe('biceps');
    expect(guessMuscle('Upright Row (Barbell)')).toBe('shoulders');
    expect(guessMuscle('Close Grip Bench Press (Barbell)')).toBe('triceps');
    expect(guessEquipment('Bench Press (Smith Machine)')).toBe('machine');
    expect(guessEquipment('Pull Up')).toBe('other');
  });
});

describe('rows of the newer export without a workout number', () => {
  it('are told apart by their date and name instead of becoming one workout', () => {
    const csv = [
      'Workout #;Date;Workout Name;Duration (sec);Exercise Name;Set Order;Weight (kg);Reps;RPE;Distance (meters);Seconds;Notes;Workout Notes',
      '7;2024-05-01 18:00:00;Push;3600;Bench Press (Barbell);1;80;8;;;;;',
      ';2024-05-03 18:00:00;Pull;3600;Pull Up;1;;9;;;;;',
      ';2024-05-05 18:00:00;Legs;3600;Squat (Barbell);1;100;5;;;;;',
      ';2024-05-05 18:00:00;Legs;3600;Squat (Barbell);2;100;5;;;;;',
    ].join('\n');
    const result = parseStrongCSV(csv);
    expect(result.workouts.map((workout) => [workout.name, workout.exercises[0].sets.length])).toEqual([['Push', 1], ['Pull', 1], ['Legs', 2]]);
  });
});
