import Time "mo:core/Time";
import Array "mo:core/Array";
import List "mo:core/List";
import Order "mo:core/Order";
import Float "mo:core/Float";
import Nat "mo:core/Nat";

actor {
  type ScoreEntry = {
    playerName : Text;
    survivalTime : Float;
    timestamp : Int;
  };

  module ScoreEntry {
    public func compare(a : ScoreEntry, b : ScoreEntry) : Order.Order {
      Float.compare(b.survivalTime, a.survivalTime);
    };
  };

  let scores = List.empty<ScoreEntry>();

  public shared ({ caller }) func submitScore(playerName : Text, survivalTime : Float) : async () {
    let newScore : ScoreEntry = {
      playerName;
      survivalTime;
      timestamp = Time.now();
    };

    scores.add(newScore);
    let sortedScores = scores.toArray().sort();
    if (sortedScores.size() > 100) {
      let truncatedScores = List.empty<ScoreEntry>();
      for (i in Nat.range(0, 100)) {
        truncatedScores.add(sortedScores[i]);
      };
      scores.clear();
      scores.addAll(truncatedScores.values());
    } else {
      scores.clear();
      scores.addAll(sortedScores.values());
    };
  };

  public query ({ caller }) func getTopScores() : async [ScoreEntry] {
    scores.toArray().sort();
  };
};
